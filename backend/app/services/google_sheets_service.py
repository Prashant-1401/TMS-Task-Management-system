import os
import json
from typing import Dict, Any, List, Optional
import gspread
from google.oauth2.service_account import Credentials
from app.config import settings

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

# Last auth/config error, surfaced via /api/health for diagnostics
_LAST_ERROR: Optional[str] = None

SHEET_HEADERS = ["SN", "Text", "Responsible", "Responsible Email", "Responsible Phone", "Due Date", "Status", "Priority", "Plant", "Department", "Created"]

ESCALATION_MATRIX_HEADERS = ["Level", "Label", "From User", "Target User", "From Role", "Target Role", "Overdue Days", "Overdue Hrs", "Notify Method", "Applicable To", "Priorities", "Active", "Description"]

ESCALATED_ACTIONS_HEADERS = ["SN", "Text", "Responsible", "Due Date", "Status", "Priority", "Plant", "Department", "Overdue Hrs", "Escalation Level", "Target User", "Escalation Label"]


def _is_configured() -> bool:
    return bool(settings.google_sheets_spreadsheet_id) and (
        settings.google_sheets_credentials_path or os.environ.get("GOOGLE_SHEETS_CREDENTIALS_JSON")
    )


def _get_client() -> Optional[gspread.Client]:
    global _LAST_ERROR
    if not _is_configured():
        _LAST_ERROR = "Not configured — need GOOGLE_SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_CREDENTIALS_JSON (or GOOGLE_SHEETS_CREDENTIALS_PATH)"
        print("[google-sheets] Not configured — skipping")
        return None
    try:
        creds_json = os.environ.get("GOOGLE_SHEETS_CREDENTIALS_JSON")
        if creds_json:
            info = json.loads(creds_json)
            creds = Credentials.from_service_account_info(info, scopes=SCOPES)
        else:
            creds_path = settings.google_sheets_credentials_path
            if not os.path.exists(creds_path):
                _LAST_ERROR = f"Credentials file not found: {creds_path}"
                print(f"[google-sheets] Credentials file not found: {creds_path}")
                return None
            creds = Credentials.from_service_account_file(creds_path, scopes=SCOPES)
        _LAST_ERROR = None
        return gspread.authorize(creds)
    except Exception as e:
        _LAST_ERROR = f"{type(e).__name__}: {e}"
        print(f"[google-sheets] Auth failed: {_LAST_ERROR}")
        return None


def _get_worksheet(client: gspread.Client, sheet_name: str = None, headers: list = None) -> Optional[gspread.Worksheet]:
    name = sheet_name or settings.google_sheets_worksheet_name
    hdrs = headers or SHEET_HEADERS
    try:
        spreadsheet = client.open_by_key(settings.google_sheets_spreadsheet_id)
        try:
            worksheet = spreadsheet.worksheet(name)
        except gspread.exceptions.WorksheetNotFound:
            worksheet = spreadsheet.add_worksheet(
                title=name,
                rows=1000,
                cols=len(hdrs),
            )
            worksheet.update(range_name="A1", values=[hdrs])
            worksheet.format(f"A1:{chr(64 + len(hdrs))}1", {"textFormat": {"bold": True}})
            print(f"[google-sheets] Created worksheet '{name}' with headers")
        return worksheet
    except Exception as e:
        print(f"[google-sheets] Failed to get worksheet '{name}': {e}")
        return None


def _action_to_row(action: Dict[str, Any]) -> List[str]:
    return [
        str(action.get("sn", "")),
        str(action.get("text", "")),
        str(action.get("responsible", "")),
        str(action.get("responsible_email", "") or ""),
        str(action.get("responsible_phone", "") or ""),
        str(action.get("due", "") or ""),
        str(action.get("status", "")),
        str(action.get("priority", "")),
        str(action.get("plant", "") or ""),
        str(action.get("dept", "") or ""),
        str(action.get("created", "") or ""),
    ]


def _find_row_by_sn(worksheet: gspread.Worksheet, sn: str) -> Optional[int]:
    try:
        sn_cells = worksheet.find(sn)
        if sn_cells:
            return sn_cells.row
    except gspread.exceptions.CellNotFound:
        return None
    return None


def sync_action_to_sheet(action: Dict[str, Any]) -> bool:
    if not _is_configured():
        return False
    client = _get_client()
    if not client:
        return False
    worksheet = _get_worksheet(client)
    if not worksheet:
        return False
    try:
        sn = action.get("sn", "")
        if not sn:
            print("[google-sheets] No SN provided, skipping sync")
            return False
        row_data = _action_to_row(action)
        existing_row = _find_row_by_sn(worksheet, sn)
        if existing_row:
            worksheet.update(range_name=f"A{existing_row}:K{existing_row}", values=[row_data])
            print(f"[google-sheets] Updated row {existing_row} for action {sn}")
        else:
            worksheet.append_row(row_data, value_input_option="USER_ENTERED")
            print(f"[google-sheets] Appended action {sn}")
        return True
    except Exception as e:
        print(f"[google-sheets] Sync failed for action {action.get('sn', '?')}: {e}")
        return False


def sync_all_actions(actions: List[Dict[str, Any]]) -> bool:
    if not _is_configured():
        return False
    client = _get_client()
    if not client:
        return False
    worksheet = _get_worksheet(client)
    if not worksheet:
        return False
    try:
        existing_rows = worksheet.get_all_values()
        if len(existing_rows) > 1:
            worksheet.delete_rows(2, len(existing_rows))
        if not actions:
            print("[google-sheets] No actions to sync")
            return True
        rows = [_action_to_row(a) for a in actions]
        worksheet.update(range_name=f"A2:K{len(rows) + 1}", values=rows)
        print(f"[google-sheets] Full sync completed: {len(rows)} actions")
        return True
    except Exception as e:
        print(f"[google-sheets] Full sync failed: {e}")
        return False


def _escalation_matrix_to_row(tier: Dict[str, Any]) -> List[str]:
    priorities = tier.get("priorities", [])
    if isinstance(priorities, list):
        priorities = ", ".join(priorities)
    return [
        str(tier.get("level", "")),
        str(tier.get("label", "") or ""),
        str(tier.get("from_user", "") or ""),
        str(tier.get("target_user", "") or ""),
        str(tier.get("from_role", "") or ""),
        str(tier.get("target_role", "") or ""),
        str(tier.get("overdue_days", 0)),
        str(tier.get("overdue_hrs", 0)),
        str(tier.get("notify_method", "") or ""),
        str(tier.get("applicable_to", "All") or "All"),
        str(priorities),
        str(tier.get("active", True)),
        str(tier.get("description", "") or ""),
    ]


def sync_escalation_matrix(tiers: List[Dict[str, Any]]) -> bool:
    if not _is_configured():
        return False
    client = _get_client()
    if not client:
        return False
    worksheet = _get_worksheet(client, sheet_name="Escalation Matrix", headers=ESCALATION_MATRIX_HEADERS)
    if not worksheet:
        return False
    try:
        existing_rows = worksheet.get_all_values()
        if len(existing_rows) > 1:
            worksheet.delete_rows(2, len(existing_rows))
        if not tiers:
            print("[google-sheets] No escalation tiers to sync")
            return True
        rows = [_escalation_matrix_to_row(t) for t in tiers]
        end_col = chr(64 + len(ESCALATION_MATRIX_HEADERS))
        worksheet.update(range_name=f"A2:{end_col}{len(rows) + 1}", values=rows)
        print(f"[google-sheets] Escalation matrix sync completed: {len(rows)} tiers")
        return True
    except Exception as e:
        print(f"[google-sheets] Escalation matrix sync failed: {e}")
        return False


def _escalated_action_to_row(action: Dict[str, Any]) -> List[str]:
    return [
        str(action.get("sn", "")),
        str(action.get("text", "")),
        str(action.get("responsible", "") or ""),
        str(action.get("due", "") or ""),
        str(action.get("status", "")),
        str(action.get("priority", "")),
        str(action.get("plant", "") or ""),
        str(action.get("dept", "") or ""),
        str(action.get("overdue_hrs", 0)),
        str(action.get("escalation_level", "")),
        str(action.get("target_user", "") or ""),
        str(action.get("escalation_label", "") or ""),
    ]


def sync_escalated_actions(actions: List[Dict[str, Any]]) -> bool:
    if not _is_configured():
        return False
    client = _get_client()
    if not client:
        return False
    worksheet = _get_worksheet(client, sheet_name="Escalated Actions", headers=ESCALATED_ACTIONS_HEADERS)
    if not worksheet:
        return False
    try:
        existing_rows = worksheet.get_all_values()
        if len(existing_rows) > 1:
            worksheet.delete_rows(2, len(existing_rows))
        if not actions:
            print("[google-sheets] No escalated actions to sync")
            return True
        rows = [_escalated_action_to_row(a) for a in actions]
        end_col = chr(64 + len(ESCALATED_ACTIONS_HEADERS))
        worksheet.update(range_name=f"A2:{end_col}{len(rows) + 1}", values=rows)
        print(f"[google-sheets] Escalated actions sync completed: {len(actions)} actions")
        return True
    except Exception as e:
        print(f"[google-sheets] Escalated actions sync failed: {e}")
        return False

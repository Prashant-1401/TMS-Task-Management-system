"""
Sheets-as-Database Service — Generic CRUD for all 17 TMS tables via Google Sheets

Works with the 20-worksheet setup:
  Plants, Departments, Roles, Users, Machines, Reasons, Projects,
  ProjectMilestones, MeetingPresets, Meetings, EscalationMatrix,
  EscalationPriorities, Actions, ActionMessages, Audit, UserSessions
  (+ legacy Adroit-Action-Sheet, Escalated Actions, Info)

Usage:
  from app.services.sheets_db_service import sheets_get_all, sheets_create, sheets_update, sheets_delete

  users = sheets_get_all("Users")
  new_user = sheets_create("Users", {"id": "USR-100", "name": "Test", ...})
  updated = sheets_update("Users", "USR-100", {"phone": "123"})
  ok = sheets_delete("Users", "USR-100")

Performance: For 100 users, 17 tables * ~50 rows = ~850 cells, reads in ~2s via Sheets API (300 reads/min limit). Writes are batched.
Caching: In-memory 30s cache per table to handle burst (e.g., 12 parallel apiGet on login).
"""

import os
import time
import json
import tempfile
from typing import Dict, Any, List, Optional
from app.config import settings
from app.services.google_sheets_service import _get_client, _is_configured

# Disk-backed cache shared across all gunicorn workers so each table is read
# from the Sheets API at most once per TTL (stays under the 60 reads/min quota).
CACHE_TTL = 60  # seconds
_CACHE_FILE = os.path.join(tempfile.gettempdir(), "tms_sheets_cache.json")
# Cache the opened Spreadsheet object to avoid an extra API metadata read per call
_SPREADSHEET = None


def _disk_get(sheet_name: str):
    try:
        if not os.path.exists(_CACHE_FILE):
            return None
        with open(_CACHE_FILE) as f:
            data = json.load(f)
        e = data.get(sheet_name)
        if e and (time.time() - e.get("ts", 0)) < CACHE_TTL:
            return e.get("rows")
    except Exception:
        pass
    return None


def _disk_set(sheet_name: str, rows):
    try:
        data = {}
        if os.path.exists(_CACHE_FILE):
            try:
                with open(_CACHE_FILE) as f:
                    data = json.load(f)
            except Exception:
                data = {}
        data[sheet_name] = {"ts": time.time(), "rows": rows}
        tmp = f"{_CACHE_FILE}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, _CACHE_FILE)
    except Exception:
        pass


def _disk_invalidate(sheet_name: str = None):
    try:
        if not os.path.exists(_CACHE_FILE):
            return
        if sheet_name is None:
            os.remove(_CACHE_FILE)
            return
        with open(_CACHE_FILE) as f:
            data = json.load(f)
        if sheet_name in data:
            del data[sheet_name]
            tmp = f"{_CACHE_FILE}.{os.getpid()}.tmp"
            with open(tmp, "w") as f:
                json.dump(data, f)
            os.replace(tmp, _CACHE_FILE)
    except Exception:
        pass

# Map sheet name -> PK column (first column is PK for all except MeetingPresets)
PK_MAP = {
    "Plants": "id",
    "Departments": "id",
    "Roles": "id",
    "Users": "id",
    "Machines": "id",
    "Reasons": "id",
    "Projects": "id",
    "ProjectMilestones": "id",
    "MeetingPresets": "type",
    "Meetings": "id",
    "EscalationMatrix": "id",
    "EscalationPriorities": "escalation_id",  # composite PK, but we use first col
    "Actions": "id",
    "ActionMessages": "id",
    "Audit": "id",
    "UserSessions": "id",
}

def _is_sheets_db_enabled() -> bool:
    """Check if Sheets-as-DB is enabled via env var"""
    return os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes") or getattr(settings, "use_google_sheets_as_db", False)

def _get_headers(worksheet) -> List[str]:
    """Get header row from worksheet"""
    try:
        return worksheet.row_values(1)
    except Exception:
        return []

# Columns that hold JSON (lists/dicts) and must be parsed back into Python objects
JSON_FIELDS = {
    "risks", "team", "attendees", "instructions", "completed_sessions",
    "guidelines", "scheduled_days", "live_draft", "priorities",
    "revision_history", "attachments",
}

def _parse_json_field(val: str):
    """Parse a JSON/Python-repr string into list/dict; fall back to [] or {}."""
    if val is None or val == "":
        return None
    s = val.strip()
    if not s or s in ("[]",):
        return []
    if s in ("{}",):
        return {}
    try:
        return json.loads(s)
    except Exception:
        pass
    try:
        import ast
        return ast.literal_eval(s)
    except Exception:
        return []

def _row_to_dict(headers: List[str], row: List[str]) -> Dict[str, Any]:
    """Convert row list to dict using headers"""
    d = {}
    for i, h in enumerate(headers):
        if i < len(row):
            val = row[i]
            # Convert empty string to None for optional fields
            if val == "":
                val = None
            # Convert boolean strings
            elif val in ("TRUE", "FALSE"):
                val = val == "TRUE"
            elif h in JSON_FIELDS and isinstance(val, str):
                val = _parse_json_field(val)
            d[h] = val
        else:
            d[h] = None
    return d

def _dict_to_row(headers: List[str], data: Dict[str, Any]) -> List[str]:
    """Convert dict to row list using headers order"""
    row = []
    for h in headers:
        val = data.get(h, "")
        if val is None:
            val = ""
        elif isinstance(val, bool):
            val = "TRUE" if val else "FALSE"
        elif isinstance(val, (list, dict)):
            val = json.dumps(val)
        else:
            val = str(val)
        row.append(val)
    return row

def _get_spreadsheet():
    """Return a cached gspread Spreadsheet (avoids one API read per call)."""
    global _SPREADSHEET
    if _SPREADSHEET is not None:
        return _SPREADSHEET
    client = _get_client()
    if not client:
        return None
    _SPREADSHEET = client.open_by_key(settings.google_sheets_spreadsheet_id)
    return _SPREADSHEET

def sheets_get_all(sheet_name: str, use_cache: bool = True) -> List[Dict[str, Any]]:
    """Get all rows from a sheet as list of dicts"""
    if not _is_configured():
        print(f"[sheets-db] Not configured, cannot get {sheet_name}")
        return []

    # Check shared disk cache (fresh within TTL → no Sheets API read)
    if use_cache:
        cached = _disk_get(sheet_name)
        if cached is not None:
            return cached

    sh = _get_spreadsheet()
    if not sh:
        return []

    try:
        try:
            ws = sh.worksheet(sheet_name)
        except Exception:
            print(f"[sheets-db] Worksheet {sheet_name} not found")
            return []

        all_values = ws.get_all_values()
        if len(all_values) < 1:
            return []

        headers = all_values[0]
        rows = []
        for row_vals in all_values[1:]:
            # Skip empty rows (PK empty)
            if not row_vals or not row_vals[0].strip():
                continue
            d = _row_to_dict(headers, row_vals)
            rows.append(d)

        # Cache
        _disk_set(sheet_name, rows)
        print(f"[sheets-db] Get {sheet_name}: {len(rows)} rows")
        return rows

    except Exception as e:
        print(f"[sheets-db] Failed to get {sheet_name}: {e}")
        return []

def _col_to_letter(col_idx: int) -> str:
    """Convert 1-based column index to A1 column letter(s), e.g. 1->A, 27->AA, 34->AH"""
    result = ""
    while col_idx > 0:
        col_idx, remainder = divmod(col_idx - 1, 26)
        result = chr(65 + remainder) + result
    return result or "A"

def sheets_get_by_id(sheet_name: str, id_val: str) -> Optional[Dict[str, Any]]:
    """Get single row by PK (with un-cached fallback if not in cache)"""
    pk = PK_MAP.get(sheet_name, "id")
    rows = sheets_get_all(sheet_name, use_cache=True)
    for r in rows:
        if str(r.get(pk, "")).strip() == str(id_val).strip():
            return r
    # Fallback to fresh read from Google Sheets
    rows = sheets_get_all(sheet_name, use_cache=False)
    for r in rows:
        if str(r.get(pk, "")).strip() == str(id_val).strip():
            return r
    return None

def sheets_create(sheet_name: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Create new row in sheet"""
    if not _is_configured():
        return None

    client = _get_client()
    if not client:
        return None

    try:
        sh = _get_spreadsheet()
        ws = sh.worksheet(sheet_name)
        headers = ws.row_values(1)

        # Check if PK already exists
        pk = PK_MAP.get(sheet_name, "id")
        if pk in data and sheets_get_by_id(sheet_name, data[pk]):
            print(f"[sheets-db] Create failed: {sheet_name} {pk}={data[pk]} already exists")
            return None

        row = _dict_to_row(headers, data)
        ws.append_row(row, value_input_option="USER_ENTERED")

        # Invalidate cache
        _disk_invalidate(sheet_name)

        print(f"[sheets-db] Created {sheet_name} {pk}={data.get(pk, '?')}")
        return data

    except Exception as e:
        print(f"[sheets-db] Create failed for {sheet_name}: {e}")
        import traceback
        traceback.print_exc()
        return None

def sheets_update(sheet_name: str, id_val: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Update row by PK"""
    if not _is_configured():
        return None

    client = _get_client()
    if not client:
        return None

    try:
        sh = _get_spreadsheet()
        ws = sh.worksheet(sheet_name)
        headers = ws.row_values(1)
        pk = PK_MAP.get(sheet_name, "id")
        pk_idx = headers.index(pk) if pk in headers else 0

        # Find row by matching the PK column
        all_values = ws.get_all_values()
        target_row = None
        for idx, row_vals in enumerate(all_values[1:], start=2):
            if len(row_vals) > pk_idx and str(row_vals[pk_idx]).strip() == str(id_val).strip():
                target_row = idx
                break

        if not target_row:
            print(f"[sheets-db] Update failed: {sheet_name} {pk}={id_val} not found")
            return None

        # Get existing row and merge
        existing = _row_to_dict(headers, all_values[target_row - 1])
        merged = {**existing, **data}
        merged[pk] = id_val  # Keep PK

        row = _dict_to_row(headers, merged)
        end_col = _col_to_letter(len(headers))
        ws.update(range_name=f"A{target_row}:{end_col}{target_row}", values=[row])

        # Invalidate cache
        _disk_invalidate(sheet_name)

        print(f"[sheets-db] Updated {sheet_name} {pk}={id_val}")
        return merged

    except Exception as e:
        print(f"[sheets-db] Update failed for {sheet_name} {id_val}: {e}")
        import traceback
        traceback.print_exc()
        return None

def sheets_delete(sheet_name: str, id_val: str) -> bool:
    """Delete row by PK"""
    if not _is_configured():
        return False

    client = _get_client()
    if not client:
        return False

    try:
        sh = _get_spreadsheet()
        ws = sh.worksheet(sheet_name)
        pk = PK_MAP.get(sheet_name, "id")
        pk_idx = headers.index(pk) if pk in headers else 0

        all_values = ws.get_all_values()
        target_row = None
        for idx, row_vals in enumerate(all_values[1:], start=2):
            if len(row_vals) > pk_idx and str(row_vals[pk_idx]).strip() == str(id_val).strip():
                target_row = idx
                break

        if not target_row:
            print(f"[sheets-db] Delete failed: {sheet_name} {pk}={id_val} not found")
            return False

        ws.delete_rows(target_row)

        # Invalidate cache
        _disk_invalidate(sheet_name)

        print(f"[sheets-db] Deleted {sheet_name} {pk}={id_val}")
        return True

    except Exception as e:
        print(f"[sheets-db] Delete failed for {sheet_name} {id_val}: {e}")
        return False

def sheets_bulk_upsert(sheet_name: str, rows: List[Dict[str, Any]]) -> Dict[str, int]:
    """Bulk upsert (insert or update) for Sheets"""
    if not _is_configured():
        return {"upserted": 0, "inserted": 0, "updated": 0}

    inserted = 0
    updated = 0
    for data in rows:
        pk = PK_MAP.get(sheet_name, "id")
        id_val = data.get(pk)
        if not id_val:
            continue
        existing = sheets_get_by_id(sheet_name, id_val)
        if existing:
            if sheets_update(sheet_name, id_val, data):
                updated += 1
        else:
            if sheets_create(sheet_name, data):
                inserted += 1

    return {"upserted": inserted + updated, "inserted": inserted, "updated": updated}

def sheets_clear_cache(sheet_name: str = None):
    """Clear cache for sheet or all"""
    if sheet_name:
        _disk_invalidate(sheet_name)
    else:
        _disk_invalidate(None)

# Convenience wrappers for each table
def get_plants(): return sheets_get_all("Plants")
def get_departments(): return sheets_get_all("Departments")
def get_roles(): return sheets_get_all("Roles")
def get_users(): return sheets_get_all("Users")
def get_machines(): return sheets_get_all("Machines")
def get_reasons(): return sheets_get_all("Reasons")
def get_projects(): return sheets_get_all("Projects")
def get_meetings(): return sheets_get_all("Meetings")
def get_actions(): return sheets_get_all("Actions")
def get_audit(): return sheets_get_all("Audit")

# Health check
def sheets_health() -> Dict[str, Any]:
    """Check Sheets DB health"""
    if not _is_configured():
        return {"configured": False, "sheets": 0, "error": "Not configured"}
    try:
        client = _get_client()
        if client is None:
            from app.services import google_sheets_service as _gss
            return {
                "configured": True,
                "sheets": 0,
                "enabled_as_db": _is_sheets_db_enabled(),
                "error": _gss._LAST_ERROR or "Google Sheets client unavailable",
            }
        sh = _get_spreadsheet()
        worksheets = sh.worksheets()
        return {
            "configured": True,
            "sheets": len(worksheets),
            "worksheet_names": [ws.title for ws in worksheets],
            "spreadsheet_url": sh.url,
            "enabled_as_db": _is_sheets_db_enabled(),
        }
    except Exception as e:
        return {"configured": True, "sheets": 0, "error": str(e)}

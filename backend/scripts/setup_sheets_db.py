#!/usr/bin/env python3
"""
Setup Google Sheets as Database — Initialize all 17 sheets for TMS

Usage:
  cd backend
  python scripts/setup_sheets_db.py              # Create/update sheets with headers + seed data from TMS_Database_Current.xlsx
  python scripts/setup_sheets_db.py --verify     # Verify sheets setup
  python scripts/setup_sheets_db.py --clear      # Clear all data (keep headers)

This script sets up the Google Sheets workbook at GOOGLE_SHEETS_SPREADSHEET_ID
with 17 worksheets matching the TMS database schema, ready to be used as primary DB
when USE_GOOGLE_SHEETS_AS_DB=true.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import openpyxl
from app.services.google_sheets_service import _get_client
from app.services.sheets_db_service import sheets_health
from app.config import settings

def setup_sheets_db():
    print("="*60)
    print("  TMS — Setup Google Sheets as Database")
    print("="*60)
    print(f"Spreadsheet ID: {settings.google_sheets_spreadsheet_id}")
    print(f"Credentials: {settings.google_sheets_credentials_path or 'GOOGLE_SHEETS_CREDENTIALS_JSON'}")
    print(f"Workbook: TMS_Database_Current.xlsx")
    print()

    # Load Excel
    excel_path = os.path.join(os.path.dirname(__file__), "../..", "TMS_Database_Current.xlsx")
    if not os.path.exists(excel_path):
        excel_path = os.path.join(os.path.dirname(__file__), "../../MCS_Database_Current.xlsx")
    if not os.path.exists(excel_path):
        print(f"ERROR: Excel not found at {excel_path}")
        return False

    wb = openpyxl.load_workbook(excel_path, data_only=True)
    client = _get_client()
    if not client:
        print("ERROR: Could not get Sheets client")
        return False

    sh = client.open_by_key(settings.google_sheets_spreadsheet_id)
    print(f"Spreadsheet: {sh.title} ({sh.url})")
    print(f"Current worksheets: {[ws.title for ws in sh.worksheets()]}")
    print()

    skip = ['README', 'DB_Schema', 'Enums', 'Indexes', 'Relationships', 'Import_Guide']
    for sheet_name in wb.sheetnames:
        if sheet_name in skip:
            continue

        ws = wb[sheet_name]
        headers = []
        for col in range(1, ws.max_column+1):
            h = ws.cell(row=3, column=col).value
            if h:
                headers.append(h)
            else:
                break

        # Get data rows
        data_rows = []
        for r in range(6, ws.max_row+1):
            pk_val = ws.cell(row=r, column=1).value
            if pk_val is None or str(pk_val).strip() == "":
                # Check if done (3 empty in a row)
                empty_count = 0
                for rr in range(r, min(r+5, ws.max_row+1)):
                    if ws.cell(row=rr, column=1).value is None or str(ws.cell(row=rr, column=1).value).strip() == "":
                        empty_count += 1
                    else:
                        break
                if empty_count >= 3:
                    break
                continue
            row = []
            for col in range(1, len(headers)+1):
                val = ws.cell(row=r, column=col).value
                if val is None:
                    val = ""
                elif val is True:
                    val = "TRUE"
                elif val is False:
                    val = "FALSE"
                else:
                    val = str(val)
                    if val == "None":
                        val = ""
                row.append(val)
            data_rows.append(row)

        print(f"{sheet_name}: {len(headers)} cols, {len(data_rows)} seed rows")

        # Create or update worksheet
        try:
            gws = sh.worksheet(sheet_name)
            print(f"  exists: {sheet_name}")
        except Exception:
            print(f"  creating: {sheet_name}")
            gws = sh.add_worksheet(title=sheet_name, rows=100, cols=len(headers))
            gws.update(range_name="A1", values=[headers])
            gws.format(f"A1:{chr(64+len(headers))}1", {"textFormat": {"bold": True}})

        # Update header if needed
        existing_header = gws.row_values(1)
        if existing_header != headers:
            print(f"  updating header")
            gws.update(range_name="A1", values=[headers])
            gws.format(f"A1:{chr(64+len(headers))}1", {"textFormat": {"bold": True}})

        # Populate data if empty
        existing = gws.get_all_values()
        if len(existing) <= 1 and data_rows:
            print(f"  populating {len(data_rows)} rows")
            gws.update(range_name="A2", values=data_rows)
        elif data_rows:
            print(f"  already has {len(existing)-1} rows, skipping populate (use --clear to reset)")
        else:
            print(f"  no seed data")

    print()
    print("Done! Final worksheets:", [ws.title for ws in sh.worksheets()])
    print(f"URL: {sh.url}")
    print()
    print("To use Sheets as DB, set in backend/.env:")
    print("  USE_GOOGLE_SHEETS_AS_DB=true")
    print("And restart backend: ./start-local.sh --prod")
    return True

def verify_sheets():
    print("Verifying Sheets DB...")
    health = sheets_health()
    print(f"Health: {health}")
    if not health.get("configured"):
        print("Not configured")
        return

    from app.services.sheets_db_service import sheets_get_all
    for sheet in ["Plants", "Users", "Actions"]:
        rows = sheets_get_all(sheet)
        print(f"{sheet}: {len(rows)} rows, e.g. {rows[0] if rows else 'empty'}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true", help="Verify sheets setup")
    parser.add_argument("--clear", action="store_true", help="Clear all data")
    args = parser.parse_args()

    if args.verify:
        verify_sheets()
    elif args.clear:
        print("Clear not implemented — manually delete rows 2+ in each sheet")
    else:
        setup_sheets_db()

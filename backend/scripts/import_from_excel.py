#!/usr/bin/env python3
"""
Import TMS Database Excel Workbook → PostgreSQL

Usage:
  cd backend
  pip install openpyxl psycopg2-binary sqlalchemy
  # Set DATABASE_URL in .env (postgresql://... or postgresql+asyncpg://...)
  python scripts/import_from_excel.py --excel ../TMS_Database_Current.xlsx --replace
  python scripts/import_from_excel.py --excel ../TMS_Database_Current.xlsx --append
  python scripts/import_from_excel.py --excel ../TMS_Database_Current.xlsx --sheet Plants --replace

Options:
  --replace  TRUNCATE table before insert (full refresh)
  --append   INSERT ... ON CONFLICT DO NOTHING (upsert, keep existing)
  --sheet    Single sheet/table to import (default: all in FK order)

FK Order (import sequentially to satisfy dependencies):
  Plants, Roles, Reasons → Departments, Machines, Users, MeetingPresets, EscalationMatrix
  → Projects, Meetings → Actions, ProjectMilestones, EscalationPriorities
  → ActionMessages, Audit, UserSessions
"""

import argparse
import os
import sys
import json
from datetime import datetime, date

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import openpyxl
except ImportError:
    print("Missing openpyxl. Run: pip install openpyxl")
    sys.exit(1)

# FK order
IMPORT_ORDER = [
    "Plants",
    "Roles",
    "Reasons",
    "Departments",
    "Machines",
    "Users",
    "MeetingPresets",
    "EscalationMatrix",
    "Projects",
    "Meetings",
    "PlantScoping",  # not a table, skip
    "Actions",
    "ProjectMilestones",
    "EscalationPriorities",
    "ActionMessages",
    "Audit",
    "UserSessions",
]

# Map sheet name → DB table + model import path
SHEET_TO_TABLE = {
    "Plants": ("plants", "Plant"),
    "Departments": ("departments", "Department"),
    "Roles": ("roles", "Role"),
    "Users": ("users", "User"),
    "Machines": ("machines", "Machine"),
    "Reasons": ("reasons", "Reason"),
    "Projects": ("projects", "Project"),
    "ProjectMilestones": ("project_milestones", "ProjectMilestone"),
    "MeetingPresets": ("meeting_presets", "MeetingPreset"),
    "Meetings": ("meetings", "Meeting"),
    "EscalationMatrix": ("escalation_matrix", "EscalationMatrix"),
    "EscalationPriorities": ("escalation_priorities", "EscalationPriority"),
    "Actions": ("actions", "Action"),
    "ActionMessages": ("action_messages", "ActionMessage"),
    "Audit": ("audit", "Audit"),
    "UserSessions": ("user_sessions", "UserSession"),
}

def parse_value(val, col_name):
    """Convert Excel cell value to DB-appropriate type."""
    if val is None or val == "":
        return None
    if isinstance(val, str):
        v = val.strip()
        if v == "":
            return None
        # Boolean
        if col_name in ["is_active", "active", "done", "recurring", "pending_confirmation", "is_current", "master_access"]:
            if v.upper() in ["TRUE", "1", "YES", "T"]:
                return True
            if v.upper() in ["FALSE", "0", "NO", "F"]:
                return False
        # Integer
        if col_name in ["level", "progress", "revisions", "version", "overdue_days", "overdue_hrs", "ord", "action_count", "duration", "dur"]:
            try:
                return int(float(v))
            except:
                return int(v) if v.isdigit() else None
        # JSONB: try to keep as string for DB to parse, or parse
        if col_name in ["risks", "team", "attendees", "instructions", "priorities", "revision_history", "attachments", "completed_sessions", "guidelines", "scheduled_days", "live_draft", "superiors"]:
            if v in ["[]", "{}"]:
                return v
            try:
                # Validate JSON
                json.loads(v)
                return v
            except:
                # Wrap single value as JSON array
                return json.dumps([v])
        return v
    if isinstance(val, (int, float)):
        # Excel may store dates as datetime
        if col_name in ["is_active", "active", "done"]:
            return bool(val)
        return val
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    return val

def import_sheet(wb, sheet_name, mode="replace", dry_run=False):
    if sheet_name not in wb.sheetnames:
        print(f"  Skip {sheet_name}: sheet not found")
        return 0

    ws = wb[sheet_name]
    # Headers in row 3
    headers = []
    for col in range(1, ws.max_column + 1):
        h = ws.cell(row=3, column=col).value
        if h:
            headers.append((col, h.strip()))
        else:
            break

    if not headers:
        print(f"  Skip {sheet_name}: no headers")
        return 0

    print(f"  {sheet_name}: headers { [h for _, h in headers] }")

    rows = []
    for r in range(6, ws.max_row + 1):
        # Skip empty rows (check PK col)
        pk_val = ws.cell(row=r, column=headers[0][0]).value
        if pk_val is None or str(pk_val).strip() == "":
            continue
        row = {}
        for col_idx, col_name in headers:
            val = ws.cell(row=r, column=col_idx).value
            row[col_name] = parse_value(val, col_name)
        # Skip rows where all values are None
        if all(v is None for v in row.values()):
            continue
        rows.append(row)

    print(f"    → {len(rows)} rows to import (mode={mode})")
    if dry_run:
        for row in rows[:2]:
            print(f"      e.g. {row}")
        return len(rows)

    # Actual DB import via SQLAlchemy/psycopg2
    # Try SQLAlchemy first
    try:
        from sqlalchemy import create_engine, text
        from app.config import settings
        # Use sync URL for import (psycopg2)
        db_url = settings.database_url
        if db_url.startswith("postgresql+asyncpg://"):
            db_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
        # Ensure sslmode
        if "neon.tech" in db_url and "sslmode" not in db_url:
            db_url += ("&" if "?" in db_url else "?") + "sslmode=require"

        engine = create_engine(db_url, pool_pre_ping=True)
        table, model_name = SHEET_TO_TABLE.get(sheet_name, (sheet_name.lower(), None))
        if not table:
            print(f"    ! No table mapping for {sheet_name}")
            return 0

        with engine.begin() as conn:
            if mode == "replace":
                # TRUNCATE ... CASCADE for FK safety, but in FK order we can just DELETE
                # Use DELETE to avoid RESTART IDENTITY issues with BIGSERIAL
                try:
                    conn.execute(text(f"TRUNCATE {table} CASCADE"))
                    print(f"    Truncated {table}")
                except Exception as e:
                    # Fallback to DELETE
                    print(f"    TRUNCATE failed for {table}: {e}; trying DELETE")
                    conn.execute(text(f"DELETE FROM {table}"))

            # Bulk insert
            for row in rows:
                # Build INSERT ... ON CONFLICT DO NOTHING for append mode
                cols = ", ".join(row.keys())
                vals = ", ".join([f":{k}" for k in row.keys()])
                if mode == "append":
                    # Need PK for conflict target; assume first col is PK
                    pk = headers[0][1]
                    sql = text(f"INSERT INTO {table} ({cols}) VALUES ({vals}) ON CONFLICT ({pk}) DO NOTHING")
                else:
                    sql = text(f"INSERT INTO {table} ({cols}) VALUES ({vals})")
                # Convert JSON strings for JSONB cols
                for k, v in list(row.items()):
                    if isinstance(v, str) and v.startswith("[") and v.endswith("]"):
                        # Check if column is JSONB
                        try:
                            json.loads(v)
                            # Keep as string, let Postgres cast
                            pass
                        except:
                            pass
                conn.execute(sql, row)
            print(f"    ✓ Inserted {len(rows)} rows into {table}")

        return len(rows)

    except Exception as e:
        print(f"    ! SQLAlchemy import failed for {sheet_name}: {e}")
        import traceback
        traceback.print_exc()
        return 0

def main():
    parser = argparse.ArgumentParser(description="Import TMS Excel → Postgres")
    parser.add_argument("--excel", required=True, help="Path to Excel workbook (TMS_Database_Current.xlsx)")
    parser.add_argument("--replace", action="store_true", help="TRUNCATE before insert")
    parser.add_argument("--append", action="store_true", help="ON CONFLICT DO NOTHING")
    parser.add_argument("--sheet", help="Single sheet to import")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, no DB write")
    args = parser.parse_args()

    if not os.path.exists(args.excel):
        print(f"Excel not found: {args.excel}")
        sys.exit(1)

    mode = "replace" if args.replace else "append" if args.append else "replace"
    wb = openpyxl.load_workbook(args.excel, data_only=True)

    print(f"Workbook: {args.excel}")
    print(f"Sheets: {wb.sheetnames}")
    print(f"Mode: {mode}, Dry run: {args.dry_run}\n")

    if args.sheet:
        import_sheet(wb, args.sheet, mode=mode, dry_run=args.dry_run)
    else:
        # Import in FK order
        for sheet in IMPORT_ORDER:
            if sheet in SHEET_TO_TABLE:
                import_sheet(wb, sheet, mode=mode, dry_run=args.dry_run)
        # Also try any remaining sheets that are tables but not in order
        for sheet in wb.sheetnames:
            if sheet in SHEET_TO_TABLE and sheet not in IMPORT_ORDER:
                import_sheet(wb, sheet, mode=mode, dry_run=args.dry_run)

    print("\nDone. Verify: curl http://localhost:8000/api/health  and  SELECT count(*) FROM actions;")

if __name__ == "__main__":
    main()

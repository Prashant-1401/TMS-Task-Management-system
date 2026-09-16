import asyncio
import json
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import openpyxl
from app.database import async_session
from sqlalchemy import text


def load_xlsx(path):
    wb = openpyxl.load_workbook(path)
    ws = wb["escalation_matrix"]
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    entries = []
    seen_ids = set()
    for row in rows:
        # Skip empty rows
        if all(v is None for v in row):
            continue
        entry_id = row[0] or f"ESC-{uuid.uuid4().hex[:8].upper()}"
        # Deduplicate IDs
        if entry_id in seen_ids:
            entry_id = f"{entry_id}-{uuid.uuid4().hex[:4].upper()}"
        seen_ids.add(entry_id)
        level = row[1]
        label = row[2] or ""
        overdue_days = row[5] or 0
        overdue_hrs = row[6] or 0
        notify_method = row[8] or "In-App + Email"
        color = row[10] or "#E69903"
        active = True
        description = row[12] or ""
        from_role = row[13] or ""
        target_role = row[14] or ""
        priorities = row[15] or '["CRITICAL","WARNING","NORMAL"]'
        if isinstance(priorities, str):
            try:
                json.loads(priorities)
            except json.JSONDecodeError:
                priorities = '["CRITICAL","WARNING","NORMAL"]'
        from_user = row[17] or ""
        target_user = row[18] or ""

        entries.append({
            "id": entry_id,
            "level": level,
            "label": label,
            "from_user": from_user,
            "target_user": target_user,
            "from_role": from_role,
            "target_role": target_role,
            "overdue_days": overdue_days,
            "overdue_hrs": overdue_hrs,
            "notify_method": notify_method,
            "priorities": priorities,
            "color": color,
            "active": active,
            "description": description,
        })
    return entries


async def main():
    entries = load_xlsx("/home/prashant/TMS ACTION IS/DB/escalation_matrix.xlsx")
    print(f"Loaded {len(entries)} escalation entries from xlsx")

    async with async_session() as db:
        # Clear existing escalation matrix
        await db.execute(text("DELETE FROM escalation_priorities"))
        await db.execute(text("DELETE FROM escalation_matrix"))
        print("Cleared existing escalation matrix")

        # Insert new entries
        for e in entries:
            e["priorities_json"] = e.pop("priorities")
            await db.execute(text(
                "INSERT INTO escalation_matrix (id, level, label, from_user, target_user, from_role, target_role, "
                "overdue_days, overdue_hrs, notify_method, priorities, color, active, description) "
                "VALUES (:id, :level, :label, :from_user, :target_user, :from_role, :target_role, "
                ":overdue_days, :overdue_hrs, :notify_method, CAST(:priorities_json AS jsonb), :color, :active, :description) "
                "ON CONFLICT (id) DO UPDATE SET "
                "level=EXCLUDED.level, label=EXCLUDED.label, from_user=EXCLUDED.from_user, target_user=EXCLUDED.target_user, "
                "from_role=EXCLUDED.from_role, target_role=EXCLUDED.target_role, overdue_days=EXCLUDED.overdue_days, "
                "overdue_hrs=EXCLUDED.overdue_hrs, notify_method=EXCLUDED.notify_method, priorities=EXCLUDED.priorities, "
                "color=EXCLUDED.color, active=EXCLUDED.active, description=EXCLUDED.description"
            ), e)

        await db.commit()
        print(f"Inserted {len(entries)} escalation tiers into database")


if __name__ == "__main__":
    asyncio.run(main())

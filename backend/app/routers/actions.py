import os
import uuid
import datetime as _dt
import base64
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from app.database import get_db, async_session
from app.models.models import Action, ActionMessage, EscalationMatrix, User, Plant, Department
from app.schemas.schemas import ActionCreate, ActionUpdate, ActionMessageCreate, ActionsEmailReq
from app.middleware.auth import require_api_key, get_current_user
from app.services.plant_scoping import scope_by_plant
from app.services.email_service import (
    dispatch_escalation_emails, send_actions_email, dispatch_daily_digests,
    send_completion_request_email, send_completion_confirmed_email, send_completion_rejected_email,
    send_attachment_email,
)
from app.services.google_sheets_service import sync_action_to_sheet, sync_all_actions

router = APIRouter(prefix="/api/actions", tags=["Actions"], dependencies=[Depends(require_api_key)])


async def _resolve_ids_to_names(db: AsyncSession, plant_id: str = None, dept_id: str = None, responsible: str = None) -> dict:
    plant_name = ""
    dept_name = ""
    resp_email = ""
    resp_phone = ""
    if plant_id:
        plant_q = await db.execute(select(Plant).where(Plant.id == plant_id))
        plant = plant_q.scalar_one_or_none()
        if plant:
            plant_name = plant.name
    if dept_id:
        dept_q = await db.execute(select(Department).where(Department.id == dept_id))
        dept = dept_q.scalar_one_or_none()
        if dept:
            dept_name = dept.name
    if responsible:
        resp_names = [n.strip() for n in responsible.split(",") if n.strip()]
        if resp_names:
            user_q = await db.execute(select(User).where(User.name == resp_names[0]))
            user = user_q.scalar_one_or_none()
            if user:
                resp_email = user.email or ""
                resp_phone = user.phone or ""
    return {"plant": plant_name, "dept": dept_name, "responsible_email": resp_email, "responsible_phone": resp_phone}


async def _action_to_sheet_dict(db: AsyncSession, action) -> dict:
    names = await _resolve_ids_to_names(db, action.plant_id, action.dept_id)
    return {
        "sn": action.sn, "text": action.text, "responsible": action.responsible,
        "due": str(action.due) if action.due else "", "status": action.status,
        "priority": action.priority, "plant": names["plant"],
        "dept": names["dept"], "created": str(action.created) if action.created else "",
    }


async def _generate_sn(db: AsyncSession) -> str:
    result = await db.execute(
        text("SELECT sn FROM actions WHERE sn ~ '^ACT-[0-9]+$' ORDER BY CAST(REPLACE(sn, 'ACT-', '') AS INTEGER) DESC LIMIT 1")
    )
    row = result.fetchone()
    if row and row[0]:
        try:
            max_num = int(row[0].replace("ACT-", ""))
        except ValueError:
            max_num = 0
    else:
        max_num = 0
    return f"ACT-{max_num + 1:03d}"


async def _check_and_dispatch_escalations_with_db(db):
    tiers_q = await db.execute(
        select(EscalationMatrix).where(EscalationMatrix.active == True)
    )
    tiers = tiers_q.scalars().all()
    if not tiers:
        return

    users_q = await db.execute(select(User))
    all_users = users_q.scalars().all()

    email_by_name = {}
    for u in all_users:
        if u.name and u.email:
            email_by_name[u.name] = u.email

    actions_q = await db.execute(
        select(Action).where(
            Action.status.notin_(["COMPLETED", "DROPPED"]),
            Action.due.isnot(None),
            Action.responsible.isnot(None),
            Action.responsible != "",
        )
    )
    open_actions = actions_q.scalars().all()

    now = datetime.now(timezone.utc)
    email_groups = {}

    for action in open_actions:
        try:
            due_dt = datetime.combine(action.due, datetime.max.time()).replace(tzinfo=timezone.utc)
            hrs_overdue = (now - due_dt).total_seconds() / 3600
        except (ValueError, TypeError):
            continue
        if hrs_overdue < 0:
            continue

        resp_names = [n.strip() for n in (action.responsible or "").split(",") if n.strip()]
        for resp_name in resp_names:
            for tier in tiers:
                if (tier.from_user or "").strip() != resp_name:
                    continue
                if hrs_overdue < (tier.overdue_hrs or 0):
                    continue
                tier_priorities = (
                    tier.priorities if isinstance(tier.priorities, list)
                    else [x.strip() for x in tier.priorities.split(",") if x.strip()]
                    if isinstance(tier.priorities, str) and tier.priorities.strip()
                    else ["CRITICAL", "WARNING", "NORMAL"]
                )
                if (action.priority or "NORMAL") not in tier_priorities:
                    continue
                notify = (tier.notify_method or "").lower()
                if "email" not in notify:
                    continue
                target_user = (tier.target_user or "").strip()
                if not target_user:
                    continue
                group_key = f"{target_user}::{tier.level}"
                if group_key not in email_groups:
                    email_groups[group_key] = {
                        "target_user": target_user,
                        "level": tier.level,
                        "actions": [],
                    }
                email_groups[group_key]["actions"].append({
                    "sn": action.sn,
                    "text": action.text,
                    "due": str(action.due),
                    "responsible": action.responsible or "",
                    "priority": action.priority or "NORMAL",
                })

    to_send = []
    for group in email_groups.values():
        target_user = group["target_user"]
        recipient_email = email_by_name.get(target_user)
        if not recipient_email or not group["actions"]:
            continue
        to_send.append({
            "recipients": [recipient_email],
            "level": group["level"],
            "target_user": target_user,
            "actions": group["actions"],
        })

    if to_send:
        dispatch_escalation_emails(to_send)


async def _bg_check_escalations():
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        return
    try:
        async with async_session() as db:
            await _check_and_dispatch_escalations_with_db(db)
    except Exception as e:
        print(f"[escalation-trigger] background check failed: {e}")
    # Also sync escalated actions to Google Sheets
    try:
        from app.routers.escalation import _bg_sync_escalated_actions
        await _bg_sync_escalated_actions()
    except Exception as e:
        print(f"[google-sheets] escalated actions sync trigger failed: {e}")


async def _sync_action_bg(action_dict: dict):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        return
    try:
        async with async_session() as db:
            names = await _resolve_ids_to_names(db, action_dict.get("plant_id"), action_dict.get("dept_id"), action_dict.get("responsible"))
            action_dict["plant"] = names["plant"]
            action_dict["dept"] = names["dept"]
            action_dict["responsible_email"] = names["responsible_email"]
            action_dict["responsible_phone"] = names["responsible_phone"]
            action_dict.pop("plant_id", None)
            action_dict.pop("dept_id", None)
            sync_action_to_sheet(action_dict)
    except Exception as e:
        print(f"[google-sheets] background sync failed: {e}")


@router.get("/")
async def list_actions(
    plant_id: str = None,
    dept_id: str = None,
    status: str = None,
    priority: str = None,
    responsible: str = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Actions", use_cache=True)
        if plant_id:
            rows = [r for r in rows if r.get("plant_id") == plant_id]
        if dept_id:
            rows = [r for r in rows if r.get("dept_id") == dept_id]
        if status:
            rows = [r for r in rows if r.get("status") == status]
        if priority:
            rows = [r for r in rows if r.get("priority") == priority]
        if responsible:
            rows = [r for r in rows if r.get("responsible") == responsible]
        # Plant scoping for Sheets
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id:
                rows = [r for r in rows if r.get("plant_id") == c_plant_id]
        # Order by created desc
        try:
            rows = sorted(rows, key=lambda x: x.get("created") or "", reverse=True)
        except Exception:
            pass
        # Clamp pagination for 300-500 user scale
        skip = max(0, skip)
        limit = max(1, min(limit, 500))
        rows = rows[skip:skip+limit]
        return rows
    # Clamp pagination for 300-500 user scale
    skip = max(0, skip)
    limit = max(1, min(limit, 500))
    q = select(Action)
    if plant_id:
        q = q.where(Action.plant_id == plant_id)
    if dept_id:
        q = q.where(Action.dept_id == dept_id)
    if status:
        q = q.where(Action.status == status)
    if priority:
        q = q.where(Action.priority == priority)
    if responsible:
        q = q.where(Action.responsible == responsible)
    q = scope_by_plant(q, current_user, Action.plant_id)
    q = q.order_by(Action.created.desc()).offset(skip).limit(limit)
    result = await db.execute(q)
    return result.scalars().all()


@router.post("/send-daily-digests")
async def send_daily_digests_endpoint(bg: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        users = sheets_get_all("Users", use_cache=True)
        email_by_name = {u.get("name"): u.get("email") for u in users if u.get("name") and u.get("email")}
        actions = sheets_get_all("Actions", use_cache=False)
        open_actions = [a for a in actions if (a.get("status") not in ["COMPLETED", "DROPPED"])]
        grouped: dict[str, list] = {}
        for a in open_actions:
            for name in [n.strip() for n in (a.get("responsible") or "").split(",") if n.strip()]:
                grouped.setdefault(name, []).append({
                    "sn": a.get("sn"), "text": a.get("text"),
                    "due": str(a.get("due")) if a.get("due") else "",
                    "status": a.get("status"), "priority": a.get("priority"),
                })
        digest_groups = [
            {"email": email_by_name[name], "name": name, "actions": acts}
            for name, acts in grouped.items()
            if name in email_by_name
        ]
        if not digest_groups:
            return {"status": "ok", "queued": 0, "reason": "No users with open actions and an email on file"}
        bg.add_task(dispatch_daily_digests, digest_groups)
        return {"status": "ok", "queued": len(digest_groups)}
    users_q = await db.execute(select(User))
    all_users = users_q.scalars().all()
    email_by_name = {u.name: u.email for u in all_users if u.name and u.email}

    actions_q = await db.execute(
        select(Action).where(Action.status.notin_(["COMPLETED", "DROPPED"]))
    )
    open_actions = actions_q.scalars().all()

    grouped: dict[str, list] = {}
    for a in open_actions:
        for name in [n.strip() for n in (a.responsible or "").split(",") if n.strip()]:
            grouped.setdefault(name, []).append({
                "sn": a.sn, "text": a.text,
                "due": str(a.due) if a.due else "",
                "status": a.status, "priority": a.priority,
            })

    digest_groups = [
        {"email": email_by_name[name], "name": name, "actions": actions}
        for name, actions in grouped.items()
        if name in email_by_name
    ]

    if not digest_groups:
        return {"status": "ok", "queued": 0, "reason": "No users with open actions and an email on file"}

    bg.add_task(dispatch_daily_digests, digest_groups)
    return {"status": "ok", "queued": len(digest_groups)}


@router.post("/send-to-email")
async def send_actions_to_email(data: ActionsEmailReq, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Actions", use_cache=False)
        actions = [r for r in rows if r.get("responsible") == data.responsible]
        if data.status:
            actions = [r for r in actions if r.get("status") == data.status]
        # Order by created desc
        try:
            actions = sorted(actions, key=lambda x: x.get("created") or "", reverse=True)
        except Exception:
            pass
        if not actions:
            raise HTTPException(status_code=404, detail="No actions found for this person")
        action_dicts = [
            {"sn": a.get("sn"), "text": a.get("text"), "due": str(a.get("due")) if a.get("due") else "", "status": a.get("status"), "priority": a.get("priority")}
            for a in actions
        ]
        sent = send_actions_email(data.email, data.responsible, action_dicts)
        if not sent:
            raise HTTPException(status_code=500, detail="Failed to send email")
        return {"ok": True, "count": len(action_dicts)}
    q = select(Action).where(Action.responsible == data.responsible)
    if data.status:
        q = q.where(Action.status == data.status)
    q = q.order_by(Action.created.desc())
    result = await db.execute(q)
    actions = result.scalars().all()
    if not actions:
        raise HTTPException(status_code=404, detail="No actions found for this person")
    action_dicts = [
        {"sn": a.sn, "text": a.text, "due": str(a.due) if a.due else "", "status": a.status, "priority": a.priority}
        for a in actions
    ]
    sent = send_actions_email(data.email, data.responsible, action_dicts)
    if not sent:
        raise HTTPException(status_code=500, detail="Failed to send email")
    return {"ok": True, "count": len(action_dicts)}


@router.get("/{action_id}")
async def get_action(action_id: str, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id
        row = sheets_get_by_id("Actions", action_id)
        if not row:
            raise HTTPException(status_code=404, detail="Action not found")
        # Plant scoping
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id and row.get("plant_id") != c_plant_id:
                raise HTTPException(status_code=404, detail="Action not found")
        return row
    q = scope_by_plant(select(Action), current_user, Action.plant_id)
    q = q.where(Action.id == action_id)
    result = await db.execute(q)
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    return action


@router.post("/")
async def create_action(data: ActionCreate, bg: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create, sheets_get_all
        payload = data.model_dump()
        payload["id"] = str(uuid.uuid4()) if not payload.get("id") else payload["id"]
        # Generate SN via Sheets if missing
        if not payload.get("sn"):
            try:
                rows = sheets_get_all("Actions", use_cache=False)
                max_num = 0
                for r in rows:
                    sn = r.get("sn") or ""
                    if sn.startswith("ACT-"):
                        try:
                            num = int(sn.replace("ACT-", ""))
                            if num > max_num:
                                max_num = num
                        except ValueError:
                            pass
                payload["sn"] = f"ACT-{max_num + 1:03d}"
            except Exception:
                payload["sn"] = f"ACT-{1:03d}"
        if "project" in payload:
            payload["project_name"] = payload.pop("project")
        for k in ("due", "date_of_action", "created", "closed_on"):
            v = payload.get(k)
            if isinstance(v, str):
                try:
                    # Keep as string for Sheets; if date string, leave as is
                    # Attempt to validate isoformat but keep string
                    _dt.date.fromisoformat(v)
                except (ValueError, TypeError):
                    pass
        row = sheets_create("Actions", payload)
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create action in Sheets")
        return row
    payload = data.model_dump()
    payload["id"] = str(uuid.uuid4())
    payload["sn"] = await _generate_sn(db)
    if "project" in payload:
        payload["project_name"] = payload.pop("project")
    for k in ("due", "date_of_action", "created", "closed_on"):
        v = payload.get(k)
        if isinstance(v, str):
            try:
                payload[k] = _dt.date.fromisoformat(v)
            except (ValueError, TypeError):
                pass
    action = Action(**payload)
    db.add(action)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        payload["sn"] = await _generate_sn(db)
        action = Action(**payload)
        db.add(action)
        await db.commit()
    await db.refresh(action)
    bg.add_task(_bg_check_escalations)
    action_dict = {
        "sn": action.sn, "text": action.text, "responsible": action.responsible,
        "due": str(action.due) if action.due else "", "status": action.status,
        "priority": action.priority, "plant_id": action.plant_id or "",
        "dept_id": action.dept_id or "", "created": str(action.created) if action.created else "",
    }
    bg.add_task(_sync_action_bg, action_dict)
    return action


# ── Helper: split a multi-person responsible string into individual names ──
def _split_responsible(raw: str) -> list[str]:
    """Split comma / slash / ampersand / 'and' separated names into a list."""
    import re
    parts = re.split(r",|/|&|\band\b", raw or "", flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


@router.patch("/{action_id}")
async def update_action(action_id: str, data: ActionUpdate, bg: BackgroundTasks,
                        db: AsyncSession = Depends(get_db),
                        current_user: dict = Depends(get_current_user)):
    # ── Shared helpers ───────────────────────────────────────────────────────
    is_admin = bool(current_user and (current_user.get("role") == "Admin" or current_user.get("is_admin")))
    user_name = current_user.get("name") if current_user else None
    user_name_clean = (user_name or "").strip().lower()

    # ════════════════════════════════════════════════════════════════════════
    # GOOGLE SHEETS PATH
    # ════════════════════════════════════════════════════════════════════════
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id, sheets_update
        existing = sheets_get_by_id("Actions", action_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Action not found")

        update_data = data.model_dump(exclude_unset=True)
        if "project" in update_data:
            update_data["project_name"] = update_data.pop("project")

        # ── Status / pendingConfirmation normalization & enforcement ──────────
        new_status = update_data.get("status")
        old_status = existing.get("status") or ""
        old_pending = existing.get("pending_confirmation") in (True, "true", "True", 1, "1")
        resp_names = _split_responsible(existing.get("responsible") or "")
        resp_names_clean = [n.strip().lower() for n in resp_names]
        alloc_name = (existing.get("allocated_by") or "").strip()
        alloc_name_clean = alloc_name.lower()
        is_allocator = bool(user_name_clean and user_name_clean == alloc_name_clean)
        is_responsible = bool(user_name_clean and user_name_clean in resp_names_clean)

        if new_status and new_status != old_status:
            # Rule 1 – request completion
            if new_status == "PENDING CONFIRM":
                if user_name_clean and not is_responsible and not is_admin:
                    raise HTTPException(status_code=403, detail="Only the responsible user or Admin can request completion")
                update_data["pending_confirmation"] = True
                update_data["closed_on"] = None
                # Notify allocator
                if alloc_name:
                    from app.services.sheets_db_service import sheets_get_all
                    all_users = sheets_get_all("Users", use_cache=True)
                    alloc_user = next((u for u in all_users if (u.get("name") or "").strip().lower() == alloc_name_clean), None)
                    if alloc_user and alloc_user.get("email"):
                        bg.add_task(send_completion_request_email, alloc_user["email"],
                                    existing.get("sn"), existing.get("text"), user_name or "Unknown", alloc_name)

            # Rule 2 – confirm completion
            elif new_status == "COMPLETED" and (old_status == "PENDING CONFIRM" or old_pending):
                if not is_allocator and not is_admin:
                    raise HTTPException(status_code=403, detail="Only the allocator or Admin can confirm completion")
                update_data["pending_confirmation"] = False
                update_data["closed_by"] = user_name
                if not update_data.get("closed_on"):
                    update_data["closed_on"] = str(_dt.date.today())
                # Notify all responsible persons
                if resp_names:
                    from app.services.sheets_db_service import sheets_get_all
                    all_users = sheets_get_all("Users", use_cache=True)
                    for rn in resp_names:
                        rn_clean = rn.strip().lower()
                        ru = next((u for u in all_users if (u.get("name") or "").strip().lower() == rn_clean), None)
                        if ru and ru.get("email"):
                            bg.add_task(send_completion_confirmed_email, ru["email"],
                                        existing.get("sn"), existing.get("text"), user_name or "Unknown")

            # Admin force-complete from any non-PENDING status
            elif new_status == "COMPLETED" and is_admin:
                update_data["pending_confirmation"] = False
                if not update_data.get("closed_on"):
                    update_data["closed_on"] = str(_dt.date.today())

            # Non-privileged user trying to jump to COMPLETED – force PENDING CONFIRM
            elif new_status == "COMPLETED":
                update_data["status"] = "PENDING CONFIRM"
                update_data["pending_confirmation"] = True
                update_data["closed_on"] = None
                if alloc_name:
                    from app.services.sheets_db_service import sheets_get_all
                    all_users = sheets_get_all("Users", use_cache=True)
                    alloc_user = next((u for u in all_users if (u.get("name") or "").strip().lower() == alloc_name_clean), None)
                    if alloc_user and alloc_user.get("email"):
                        bg.add_task(send_completion_request_email, alloc_user["email"],
                                    existing.get("sn"), existing.get("text"), user_name or "Unknown", alloc_name)

            # Rule 3 – reject completion
            elif new_status == "IN PROCESS" and (old_status == "PENDING CONFIRM" or old_pending):
                if not is_allocator and not is_admin:
                    raise HTTPException(status_code=403, detail="Only the allocator or Admin can reject completion")
                update_data["pending_confirmation"] = False
                update_data["closed_on"] = None
                # Notify all responsible persons
                if resp_names:
                    from app.services.sheets_db_service import sheets_get_all
                    all_users = sheets_get_all("Users", use_cache=True)
                    for rn in resp_names:
                        rn_clean = rn.strip().lower()
                        ru = next((u for u in all_users if (u.get("name") or "").strip().lower() == rn_clean), None)
                        if ru and ru.get("email"):
                            bg.add_task(send_completion_rejected_email, ru["email"],
                                        existing.get("sn"), existing.get("text"), user_name or "Unknown")

            # DROPPED: close and clear pending
            elif new_status == "DROPPED":
                update_data["pending_confirmation"] = False
                if not update_data.get("closed_on"):
                    update_data["closed_on"] = str(_dt.date.today())

            # Any other status change: clear pending flag
            else:
                update_data["pending_confirmation"] = False
                update_data["closed_on"] = None

        elif update_data.get("pending_confirmation") is False and old_pending:
            if not is_allocator and not is_admin:
                raise HTTPException(status_code=403, detail="Only the allocator or Admin can clear pending confirmation")
        # ── End Sheets status enforcement ────────────────────────────────────

        # Preserve revision_history merge
        if "revision_history" in update_data:
            incoming_history = update_data.pop("revision_history")
            current_history = existing.get("revision_history") or []
            if isinstance(current_history, str):
                import json
                try:
                    current_history = json.loads(current_history)
                except Exception:
                    current_history = []
            if incoming_history and isinstance(incoming_history, list):
                current_history = current_history + incoming_history
            update_data["revision_history"] = current_history
            try:
                update_data["revisions"] = int(existing.get("revisions") or 0) + 1
            except Exception:
                update_data["revisions"] = 1

        # Preserve attachments merge
        if "attachments" in update_data:
            incoming = update_data["attachments"] or []
            existing_atts = existing.get("attachments") or []
            if isinstance(existing_atts, str):
                import json
                try:
                    existing_atts = json.loads(existing_atts)
                except Exception:
                    existing_atts = []
            if not isinstance(existing_atts, list):
                existing_atts = []
            existing_dict = {a.get("id"): a for a in existing_atts if isinstance(a, dict) and "data" in a}
            merged = []
            for att in incoming:
                if isinstance(att, dict) and att.get("id") in existing_dict and "data" not in att:
                    merged.append(existing_dict[att["id"]])
                else:
                    merged.append(att)
            update_data["attachments"] = merged

        # version bump
        try:
            update_data["version"] = int(existing.get("version") or 0) + 1
        except Exception:
            pass

        row = sheets_update("Actions", action_id, update_data)
        if not row:
            raise HTTPException(status_code=404, detail="Action not found")
        return row

    # ════════════════════════════════════════════════════════════════════════
    # DATABASE (PostgreSQL) PATH
    # ════════════════════════════════════════════════════════════════════════
    result = await db.execute(
        select(Action).where(Action.id == action_id).with_for_update()
    )
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    update_data = data.model_dump(exclude_unset=True)
    if "project" in update_data:
        update_data["project_name"] = update_data.pop("project")

    new_status = update_data.get("status")
    old_status = action.status
    old_pending = action.pending_confirmation
    resp_names = _split_responsible(action.responsible or "")
    resp_names_clean = [n.strip().lower() for n in resp_names]
    alloc_name = (action.allocated_by or "").strip()
    alloc_name_clean = alloc_name.lower()
    is_allocator = bool(user_name_clean and user_name_clean == alloc_name_clean)
    is_responsible = bool(user_name_clean and user_name_clean in resp_names_clean)

    # ── Step 1: Always keep pendingConfirmation in sync with status ──────────
    if new_status == "PENDING CONFIRM":
        update_data["pending_confirmation"] = True
        update_data["closed_on"] = None
    elif new_status in ("COMPLETED", "DROPPED"):
        update_data["pending_confirmation"] = False
        if new_status == "COMPLETED" and not update_data.get("closed_on"):
            update_data["closed_on"] = _dt.date.today()
    elif new_status:
        update_data["pending_confirmation"] = False
        update_data["closed_on"] = None
    elif update_data.get("pending_confirmation") is True:
        # Sending pendingConfirmation=True without status = ignored
        update_data["pending_confirmation"] = False

    # ── Step 2: Permission-gated transition rules ────────────────────────────
    if new_status and new_status != old_status:
        # Rule 1 – request completion (→ PENDING CONFIRM)
        if new_status == "PENDING CONFIRM":
            if user_name_clean and not is_responsible and not is_admin:
                raise HTTPException(status_code=403, detail="Only the responsible user or Admin can request completion")
            update_data["pending_confirmation"] = True
            update_data["closed_on"] = None
            # Notify allocator
            if alloc_name:
                alloc_q = await db.execute(select(User).where(User.name.ilike(alloc_name)))
                allocator = alloc_q.scalar_one_or_none()
                if allocator and allocator.email:
                    bg.add_task(send_completion_request_email, allocator.email,
                                action.sn, action.text, user_name or "Unknown", alloc_name)

        # Rule 2 – confirm completion (PENDING CONFIRM → COMPLETED)
        elif new_status == "COMPLETED" and (old_status == "PENDING CONFIRM" or old_pending):
            if not is_allocator and not is_admin:
                raise HTTPException(status_code=403, detail="Only the allocator or Admin can confirm completion")
            update_data["pending_confirmation"] = False
            update_data["closed_by"] = user_name
            if not update_data.get("closed_on"):
                update_data["closed_on"] = _dt.date.today()
            # Notify all responsible persons
            if resp_names:
                from sqlalchemy import or_
                resp_q = await db.execute(select(User).where(or_(*[User.name.ilike(rn) for rn in resp_names])))
                for resp_user in resp_q.scalars().all():
                    if resp_user and resp_user.email:
                        bg.add_task(send_completion_confirmed_email, resp_user.email,
                                    action.sn, action.text, user_name or "Unknown")

        # Rule 4 – Admin force-complete from any status (bypass PENDING CONFIRM)
        elif new_status == "COMPLETED" and is_admin:
            update_data["pending_confirmation"] = False
            if not update_data.get("closed_on"):
                update_data["closed_on"] = _dt.date.today()
            # Note: closed_by NOT set here (force-complete, not a confirm)

        # Rule 3 – non-privileged user jumps directly to COMPLETED → force PENDING CONFIRM
        elif new_status == "COMPLETED":
            update_data["status"] = "PENDING CONFIRM"
            update_data["pending_confirmation"] = True
            update_data["closed_on"] = None
            if alloc_name:
                alloc_q = await db.execute(select(User).where(User.name.ilike(alloc_name)))
                allocator = alloc_q.scalar_one_or_none()
                if allocator and allocator.email:
                    bg.add_task(send_completion_request_email, allocator.email,
                                action.sn, action.text, user_name or "Unknown", alloc_name)

        # Rule 3b – reject completion (PENDING CONFIRM → IN PROCESS)
        elif new_status == "IN PROCESS" and (old_status == "PENDING CONFIRM" or old_pending):
            if not is_allocator and not is_admin:
                raise HTTPException(status_code=403, detail="Only the allocator or Admin can reject completion")
            update_data["pending_confirmation"] = False
            update_data["closed_on"] = None
            # Notify all responsible persons
            if resp_names:
                from sqlalchemy import or_
                resp_q = await db.execute(select(User).where(or_(*[User.name.ilike(rn) for rn in resp_names])))
                for resp_user in resp_q.scalars().all():
                    if resp_user and resp_user.email:
                        bg.add_task(send_completion_rejected_email, resp_user.email,
                                    action.sn, action.text, user_name or "Unknown")

        # Any other status change: clear pending flag and closedOn
        else:
            update_data["pending_confirmation"] = False
            if new_status not in ("COMPLETED", "DROPPED"):
                update_data.setdefault("closed_on", None)

    elif update_data.get("pending_confirmation") is False and old_pending:
        if not is_allocator and not is_admin:
            raise HTTPException(status_code=403, detail="Only the allocator or Admin can clear pending confirmation")
    # ── End status enforcement ───────────────────────────────────────────────

    if "revision_history" in update_data:
        incoming_history = update_data.pop("revision_history")
        current_history = action.revision_history or []
        if incoming_history and isinstance(incoming_history, list):
            current_history = current_history + incoming_history
        update_data["revision_history"] = current_history
        update_data["revisions"] = (action.revisions or 0) + 1

    # Preserve base64 data in attachments if frontend sends metadata-only list
    if "attachments" in update_data:
        incoming = update_data["attachments"] or []
        existing_atts = {a["id"]: a for a in (action.attachments or []) if "data" in a}
        merged = []
        for att in incoming:
            if att.get("id") in existing_atts and "data" not in att:
                merged.append(existing_atts[att["id"]])
            else:
                merged.append(att)
        update_data["attachments"] = merged

    for k, v in update_data.items():
        if isinstance(v, str) and k in ("due", "date_of_action", "closed_on", "created"):
            try:
                v = _dt.date.fromisoformat(v)
            except (ValueError, TypeError):
                pass
        setattr(action, k, v)
    action.version = (action.version or 0) + 1
    await db.commit()
    await db.refresh(action)
    bg.add_task(_bg_check_escalations)
    action_dict = {
        "sn": action.sn, "text": action.text, "responsible": action.responsible,
        "due": str(action.due) if action.due else "", "status": action.status,
        "priority": action.priority, "plant_id": action.plant_id or "",
        "dept_id": action.dept_id or "", "created": str(action.created) if action.created else "",
    }
    bg.add_task(_sync_action_bg, action_dict)
    return action


@router.delete("/{action_id}")
async def delete_action(action_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_delete
        if not sheets_delete("Actions", action_id):
            raise HTTPException(status_code=404, detail="Action not found")
        return {"ok": True}
    result = await db.execute(select(Action).where(Action.id == action_id))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    await db.delete(action)
    await db.commit()
    return {"ok": True}


@router.get("/{action_id}/messages")
async def list_action_messages(action_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("ActionMessages", use_cache=True)
        rows = [r for r in rows if str(r.get("action_id")) == str(action_id)]
        try:
            rows = sorted(rows, key=lambda x: x.get("ts") or "")
        except Exception:
            pass
        return rows
    result = await db.execute(
        select(ActionMessage).where(ActionMessage.action_id == action_id).order_by(ActionMessage.ts)
    )
    return result.scalars().all()


@router.post("/{action_id}/messages")
async def create_action_message(action_id: str, data: ActionMessageCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create
        payload = data.model_dump(exclude={"id", "action_id"})
        # Generate id if not provided; Sheets PK is id
        new_id = str(uuid.uuid4())
        # Sheets expects id as string; store with action_id
        sheets_payload = {"id": new_id, "action_id": action_id, **payload}
        if not sheets_payload.get("ts"):
            sheets_payload["ts"] = datetime.now(timezone.utc).isoformat()
        row = sheets_create("ActionMessages", sheets_payload)
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create message in Sheets")
        return row
    msg = ActionMessage(action_id=action_id, **data.model_dump(exclude={"id", "action_id"}))
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return msg


@router.post("/{action_id}/attachments")
async def upload_attachment(action_id: str, file: UploadFile = File(...), bg: BackgroundTasks = None, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id, sheets_update, sheets_get_all
        row = sheets_get_by_id("Actions", action_id)
        if not row:
            raise HTTPException(status_code=404, detail="Action not found")
        content = await file.read()
        max_bytes = 5 * 1024 * 1024  # 5 MB limit
        if len(content) > max_bytes:
            raise HTTPException(status_code=400, detail="File size exceeds 5 MB limit")
        allowed_mimes = {
            "application/pdf",
            "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "text/csv",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
        if file.content_type and file.content_type not in allowed_mimes:
            raise HTTPException(status_code=400, detail=f"File type '{file.content_type}' is not allowed")
        b64_data = base64.b64encode(content).decode("utf-8")
        attachment = {
            "id": str(uuid.uuid4()),
            "filename": file.filename or "unnamed",
            "mimetype": file.content_type or "application/octet-stream",
            "size": len(content),
            "data": b64_data,
        }
        current = row.get("attachments")
        # Sheets may store attachments as stringified JSON; normalize to list
        if isinstance(current, str):
            import json
            try:
                current = json.loads(current)
            except Exception:
                # Try eval-like fallback
                current = []
        if not isinstance(current, list):
            current = []
        # Filter out non-dict entries if corrupted
        current = [a for a in current if isinstance(a, dict)]
        current.append(attachment)
        version = row.get("version")
        update_payload = {"attachments": current}
        if version is not None:
            try:
                update_payload["version"] = int(version) + 1
            except Exception:
                pass
        updated = sheets_update("Actions", action_id, update_payload)
        if not updated:
            raise HTTPException(status_code=500, detail="Failed to update attachments in Sheets")
        # Try to send email notification via Sheets users lookup
        if bg and row.get("allocated_by"):
            try:
                users = sheets_get_all("Users", use_cache=True)
                allocator_email = None
                for u in users:
                    if u.get("name") == row.get("allocated_by"):
                        allocator_email = u.get("email")
                        break
                if allocator_email:
                    bg.add_task(
                        send_attachment_email, allocator_email, row.get("sn"), row.get("text"),
                        row.get("responsible") or "Unknown", file.filename or "unnamed",
                        b64_data, file.content_type or "application/octet-stream",
                    )
            except Exception:
                pass
        return {"ok": True, "attachment": {"id": attachment["id"], "filename": attachment["filename"], "mimetype": attachment["mimetype"], "size": attachment["size"]}}
    result = await db.execute(select(Action).where(Action.id == action_id))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")

    content = await file.read()
    max_bytes = 5 * 1024 * 1024  # 5 MB limit
    if len(content) > max_bytes:
        raise HTTPException(status_code=400, detail="File size exceeds 5 MB limit")

    allowed_mimes = {
        "application/pdf",
        "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "text/csv",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    if file.content_type and file.content_type not in allowed_mimes:
        raise HTTPException(status_code=400, detail=f"File type '{file.content_type}' is not allowed")

    b64_data = base64.b64encode(content).decode("utf-8")
    attachment = {
        "id": str(uuid.uuid4()),
        "filename": file.filename or "unnamed",
        "mimetype": file.content_type or "application/octet-stream",
        "size": len(content),
        "data": b64_data,
    }
    current = action.attachments or []
    current.append(attachment)
    action.attachments = current
    action.version = (action.version or 0) + 1
    await db.commit()

    if bg and action.allocated_by:
        alloc_q = await db.execute(select(User).where(User.name == action.allocated_by))
        allocator = alloc_q.scalar_one_or_none()
        if allocator and allocator.email:
            bg.add_task(
                send_attachment_email, allocator.email, action.sn, action.text,
                action.responsible or "Unknown", file.filename or "unnamed",
                b64_data, file.content_type or "application/octet-stream",
            )

    return {"ok": True, "attachment": {"id": attachment["id"], "filename": attachment["filename"], "mimetype": attachment["mimetype"], "size": attachment["size"]}}


@router.delete("/{action_id}/attachments/{attachment_id}")
async def delete_attachment(action_id: str, attachment_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id, sheets_update
        row = sheets_get_by_id("Actions", action_id)
        if not row:
            raise HTTPException(status_code=404, detail="Action not found")
        current = row.get("attachments") or []
        if isinstance(current, str):
            import json
            try:
                current = json.loads(current)
            except Exception:
                current = []
        if not isinstance(current, list):
            current = []
        current = [a for a in current if isinstance(a, dict) and a.get("id") != attachment_id]
        version = row.get("version")
        update_payload = {"attachments": current}
        if version is not None:
            try:
                update_payload["version"] = int(version) + 1
            except Exception:
                pass
        sheets_update("Actions", action_id, update_payload)
        return {"ok": True}
    result = await db.execute(select(Action).where(Action.id == action_id))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    current = action.attachments or []
    action.attachments = [a for a in current if a.get("id") != attachment_id]
    action.version = (action.version or 0) + 1
    await db.commit()
    return {"ok": True}


@router.post("/bulk")
async def bulk_upsert_actions(rows: list[ActionCreate], bg: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert, sheets_get_all
        # Prepare sheets rows with SN generation for missing sn
        existing_rows = sheets_get_all("Actions", use_cache=False)
        max_num = 0
        for r in existing_rows:
            sn = r.get("sn") or ""
            if sn.startswith("ACT-"):
                try:
                    num = int(sn.replace("ACT-", ""))
                    if num > max_num:
                        max_num = num
                except ValueError:
                    pass
        sheets_rows = []
        for data in rows:
            payload = data.model_dump()
            if "project" in payload:
                payload["project_name"] = payload.pop("project")
            for k in ("due", "date_of_action", "created", "closed_on"):
                v = payload.get(k)
                if isinstance(v, str):
                    try:
                        _dt.date.fromisoformat(v)
                    except (ValueError, TypeError):
                        pass
            if not payload.get("id"):
                payload["id"] = str(uuid.uuid4())
            if not payload.get("sn"):
                max_num += 1
                payload["sn"] = f"ACT-{max_num:03d}"
            sheets_rows.append(payload)
        result = sheets_bulk_upsert("Actions", sheets_rows)
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        payload = data.model_dump()
        if "project" in payload:
            payload["project_name"] = payload.pop("project")
        for k in ("due", "date_of_action", "created", "closed_on"):
            v = payload.get(k)
            if isinstance(v, str):
                try:
                    payload[k] = _dt.date.fromisoformat(v)
                except (ValueError, TypeError):
                    pass
        action_id = payload.get("id")
        if action_id:
            result = await db.execute(select(Action).where(Action.id == action_id))
            existing = result.scalar_one_or_none()
            if existing:
                for k, v in payload.items():
                    if k != "id":
                        setattr(existing, k, v)
                upserted += 1
                continue
        if not payload.get("id"):
            payload["id"] = str(uuid.uuid4())
        if not payload.get("sn"):
            payload["sn"] = await _generate_sn(db)
        db.add(Action(**payload))
        upserted += 1
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        for data in rows:
            payload = data.model_dump()
            if "project" in payload:
                payload["project_name"] = payload.pop("project")
            for k in ("due", "date_of_action", "created", "closed_on"):
                v = payload.get(k)
                if isinstance(v, str):
                    try:
                        payload[k] = _dt.date.fromisoformat(v)
                    except (ValueError, TypeError):
                        pass
            action_id = payload.get("id")
            if action_id:
                result = await db.execute(select(Action).where(Action.id == action_id))
                existing = result.scalar_one_or_none()
                if existing:
                    for k, v in payload.items():
                        if k != "id":
                            setattr(existing, k, v)
                    continue
            payload["id"] = str(uuid.uuid4())
            payload["sn"] = await _generate_sn(db)
            db.add(Action(**payload))
        await db.commit()
    bg.add_task(_bg_check_escalations)
    return {"ok": True, "upserted": upserted}


@router.post("/sync-to-sheet")
async def sync_actions_to_sheet(db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        # In Sheets-as-DB mode, data already in Sheets
        return {"ok": True, "synced": 0, "note": "Sheets is primary DB, sync not needed"}
    result = await db.execute(select(Action).order_by(Action.created.desc()))
    actions = result.scalars().all()
    action_dicts = []
    for a in actions:
        names = await _resolve_ids_to_names(db, a.plant_id, a.dept_id, a.responsible)
        action_dicts.append({
            "sn": a.sn, "text": a.text, "responsible": a.responsible,
            "responsible_email": names["responsible_email"],
            "responsible_phone": names["responsible_phone"],
            "due": str(a.due) if a.due else "", "status": a.status,
            "priority": a.priority, "plant": names["plant"],
            "dept": names["dept"], "created": str(a.created) if a.created else "",
        })
    success = sync_all_actions(action_dicts)
    if not success:
        return {"ok": False, "error": "Google Sheets not configured or sync failed"}
    return {"ok": True, "synced": len(action_dicts)}

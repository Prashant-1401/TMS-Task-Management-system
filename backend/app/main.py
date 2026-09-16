from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.config import settings
from app.database import engine, Base, get_db
from app.routers import (
    auth, plants, departments, roles, users, machines, reasons,
    actions, projects, meetings, escalation, audit, meetings_ai,
    translate, email_share, sessions,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.run_sync(migrate_schema)
        print("[lifespan] Database schema initialized successfully")
    except Exception as e:
        print(f"[lifespan] Database initialization warning: {e}")
        print("[lifespan] Server will continue — some tables may need manual creation")
    yield
    await engine.dispose()


def migrate_schema(conn):
    from sqlalchemy import inspect, text
    inspector = inspect(conn)
    existing_tables = set(inspector.get_table_names())

    # Escalation matrix columns
    if "escalation_matrix" in existing_tables:
        try:
            columns = {c["name"] for c in inspector.get_columns("escalation_matrix")}
            if "from_user" not in columns:
                conn.execute(text(
                    "ALTER TABLE escalation_matrix ADD COLUMN from_user VARCHAR(100)"
                ))
            if "target_user" not in columns:
                conn.execute(text(
                    "ALTER TABLE escalation_matrix ADD COLUMN target_user VARCHAR(100)"
                ))
            if "from_role" not in columns:
                conn.execute(text(
                    "ALTER TABLE escalation_matrix ADD COLUMN from_role VARCHAR(50)"
                ))
            if "target_role" not in columns:
                conn.execute(text(
                    "ALTER TABLE escalation_matrix ADD COLUMN target_role VARCHAR(50)"
                ))
            if "priorities" not in columns:
                conn.execute(text(
                    "ALTER TABLE escalation_matrix ADD COLUMN priorities JSONB DEFAULT '[]'::jsonb"
                ))
            # Backfill NULL priorities for existing rows
            conn.execute(text(
                "UPDATE escalation_matrix SET priorities = '[\"CRITICAL\",\"WARNING\",\"NORMAL\"]'::jsonb WHERE priorities IS NULL"
            ))
            # Seed default escalation matrix if empty
            count_row = conn.execute(text("SELECT COUNT(*) FROM escalation_matrix")).scalar()
            if count_row == 0:
                # Build default tiers from actual users in the database
                user_rows = conn.execute(text("SELECT name, role FROM users WHERE is_active = true")).fetchall()
                user_by_role = {}
                for row in user_rows:
                    user_by_role.setdefault(row[1], []).append(row[0])

                defaults = []
                tier_id = 1

                # Level 1 (24h): each user escalates to their direct superior
                escalation_chains = [
                    ("Supervisor", "HOD"),
                    ("Shift Engineer", "HOD"),
                    ("HOD", "Plant Head"),
                    ("Plant Head", "MD"),
                ]
                for from_role, to_role in escalation_chains:
                    for from_name in user_by_role.get(from_role, []):
                        for to_name in user_by_role.get(to_role, []):
                            defaults.append({
                                "id": f"E1-{tier_id}",
                                "level": 1,
                                "label": f"L1: {from_name} → {to_name}",
                                "from_user": from_name,
                                "target_user": to_name,
                                "from_role": from_role,
                                "target_role": to_role,
                                "overdue_hrs": 24,
                                "notify_method": "In-App + Email",
                                "priorities": '["CRITICAL","WARNING","NORMAL"]',
                                "color": "#E69903",
                                "active": True,
                                "description": f"{from_name} overdue 24h → escalate to {to_name}",
                            })
                            tier_id += 1

                # Level 2 (72h): skip one level up
                escalation_chains_l2 = [
                    ("Supervisor", "Plant Head"),
                    ("Shift Engineer", "Plant Head"),
                    ("HOD", "MD"),
                ]
                for from_role, to_role in escalation_chains_l2:
                    for from_name in user_by_role.get(from_role, []):
                        for to_name in user_by_role.get(to_role, []):
                            defaults.append({
                                "id": f"E2-{tier_id}",
                                "level": 2,
                                "label": f"L2: {from_name} → {to_name}",
                                "from_user": from_name,
                                "target_user": to_name,
                                "from_role": from_role,
                                "target_role": to_role,
                                "overdue_hrs": 72,
                                "notify_method": "In-App + Email",
                                "priorities": '["CRITICAL","WARNING"]',
                                "color": "#E67E22",
                                "active": True,
                                "description": f"{from_name} overdue 72h → escalate to {to_name}",
                            })
                            tier_id += 1

                # Level 3 (168h): two levels up
                escalation_chains_l3 = [
                    ("Supervisor", "MD"),
                    ("Shift Engineer", "MD"),
                ]
                for from_role, to_role in escalation_chains_l3:
                    for from_name in user_by_role.get(from_role, []):
                        for to_name in user_by_role.get(to_role, []):
                            defaults.append({
                                "id": f"E3-{tier_id}",
                                "level": 3,
                                "label": f"L3: {from_name} → {to_name}",
                                "from_user": from_name,
                                "target_user": to_name,
                                "from_role": from_role,
                                "target_role": to_role,
                                "overdue_hrs": 168,
                                "notify_method": "In-App + Email",
                                "priorities": '["CRITICAL"]',
                                "color": "#C0392B",
                                "active": True,
                                "description": f"{from_name} overdue 7d → escalate to {to_name}",
                            })
                            tier_id += 1

                for d in defaults:
                    conn.execute(text(
                        "INSERT INTO escalation_matrix (id, level, label, from_user, target_user, from_role, target_role, overdue_hrs, notify_method, priorities, color, active, description) "
                        "VALUES (:id, :level, :label, :from_user, :target_user, :from_role, :target_role, :overdue_hrs, :notify_method, :priorities::jsonb, :color, :active, :description)"
                    ), d)
        except Exception as e:
            print(f"[migrate] escalation_matrix migration skipped: {e}")

    # Meetings table columns
    if "meetings" in existing_tables:
        try:
            mtg_cols = {c["name"] for c in inspector.get_columns("meetings")}
            if "guidelines" not in mtg_cols:
                conn.execute(text(
                    "ALTER TABLE meetings ADD COLUMN guidelines JSONB DEFAULT '[]'::jsonb"
                ))
            if "scheduled_days" not in mtg_cols:
                conn.execute(text(
                    "ALTER TABLE meetings ADD COLUMN scheduled_days JSONB DEFAULT '[]'::jsonb"
                ))
            if "live_draft" not in mtg_cols:
                conn.execute(text(
                    "ALTER TABLE meetings ADD COLUMN live_draft JSONB DEFAULT '{}'::jsonb"
                ))
        except Exception as e:
            print(f"[migrate] meetings column migration skipped: {e}")

    # Actions table columns
    if "actions" in existing_tables:
        try:
            action_cols = {c["name"] for c in inspector.get_columns("actions")}
            if "version" not in action_cols:
                conn.execute(text(
                    "ALTER TABLE actions ADD COLUMN version INTEGER DEFAULT 1"
                ))
            if "src_id" not in action_cols:
                conn.execute(text(
                    "ALTER TABLE actions ADD COLUMN src_id TEXT REFERENCES meetings(id) ON UPDATE CASCADE ON DELETE SET NULL"
                ))
            if "meetingid" not in action_cols:
                conn.execute(text(
                    "ALTER TABLE actions ADD COLUMN meetingid TEXT REFERENCES meetings(id) ON UPDATE CASCADE ON DELETE SET NULL"
                ))
            if "meeting_name" not in action_cols:
                conn.execute(text(
                    "ALTER TABLE actions ADD COLUMN meeting_name TEXT"
                ))
            if "attachments" not in action_cols:
                conn.execute(text(
                    "ALTER TABLE actions ADD COLUMN attachments JSONB DEFAULT '[]'::jsonb"
                ))
        except Exception as e:
            print(f"[migrate] actions column migration skipped: {e}")

    # Users table — master_access column
    if "users" in existing_tables:
        try:
            user_cols = {c["name"] for c in inspector.get_columns("users")}
            if "master_access" not in user_cols:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN master_access BOOLEAN DEFAULT FALSE"
                ))
        except Exception as e:
            print(f"[migrate] users master_access migration skipped: {e}")

    # User sessions table (multi-device / session management)
    if "user_sessions" not in existing_tables:
        try:
            conn.execute(text(
                "CREATE TABLE user_sessions ("
                "id VARCHAR PRIMARY KEY, "
                "user_id VARCHAR NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE, "
                "token_jti VARCHAR NOT NULL UNIQUE, "
                "device VARCHAR(120), "
                "browser VARCHAR(120), "
                "ip VARCHAR(64), "
                "location VARCHAR(120), "
                "created_at TIMESTAMPTZ DEFAULT now(), "
                "last_seen TIMESTAMPTZ DEFAULT now(), "
                "is_current BOOLEAN DEFAULT FALSE)"
            ))
        except Exception as e:
            print(f"[migrate] user_sessions table creation skipped: {e}")


app = FastAPI(
    title="TMS Backend API",
    description="Task Management System — Backend API",
    version="2.0.0",
    lifespan=lifespan,
)

origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]
if not origins:
    origins = ["*"]
else:
    known = [
        "https://tms-task-mangement-system.vercel.app",
        "https://tms-control-management.vercel.app",
        "https://tms-control-management-g9uaoyxl1.vercel.app",
        "https://mcs-control-management.vercel.app",
        "https://mcs-control-management-g9uaoyxl1.vercel.app",
        "http://localhost:5173",
    ]
    for o in known:
        if o not in origins:
            origins.append(o)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=bool(origins and origins != ["*"]),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "x-api-key"],
)


@app.exception_handler(IntegrityError)
async def integrity_error_handler(request: Request, exc: IntegrityError):
    print(f"IntegrityError on {request.url.path}: {exc.orig}")
    return JSONResponse(
        status_code=409,
        content={"detail": "Data conflict — a record with this value already exists. Please refresh and try again."},
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"Unhandled error on {request.url.path}: {type(exc).__name__}: {exc}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/")
async def root():
    return {"message": "TMS Backend API is running", "docs": "/docs", "health": "/api/health"}


@app.get("/api/health")
async def health():
    from app.services.sheets_db_service import sheets_health
    sheets = sheets_health()
    return {
        "status": "ok",
        "gemini_configured": bool(settings.gemini_api_key),
        "gemini_model": settings.gemini_model,
        "smtp_configured": bool(settings.smtp_user and settings.smtp_password),
        "wacrm_gateway_configured": bool(settings.wacrm_alert_url),
        "api_key_auth_enabled": bool(settings.api_key),
        "cors_locked": bool(origins and origins != ["*"]),
        "sheets_configured": sheets.get("configured", False),
        "sheets_as_db": sheets.get("enabled_as_db", False),
        "sheets_count": sheets.get("sheets", 0),
    }


@app.get("/api/ping")
async def ping():
    return {"ok": True, "gemini_ready": bool(settings.gemini_api_key)}


@app.get("/api/actions/{action_id}/attachments/{attachment_id}")
async def download_attachment(action_id: str, attachment_id: str, db: AsyncSession = Depends(get_db)):
    import base64 as _b64
    from sqlalchemy import select as _sel
    from app.models.models import Action as _Act
    from fastapi.responses import Response as _Resp
    result = await db.execute(_sel(_Act).where(_Act.id == action_id))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    att = next((a for a in (action.attachments or []) if a.get("id") == attachment_id), None)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    file_bytes = _b64.b64decode(att["data"])
    return _Resp(
        content=file_bytes,
        media_type=att.get("mimetype", "application/octet-stream"),
        headers={"Content-Disposition": f"attachment; filename=\"{att['filename']}\""}
    )


app.include_router(auth.router)
app.include_router(plants.router)
app.include_router(departments.router)
app.include_router(roles.router)
app.include_router(users.router)
app.include_router(machines.router)
app.include_router(reasons.router)
app.include_router(actions.router)
app.include_router(projects.router)
app.include_router(meetings.router)
app.include_router(escalation.router)
app.include_router(audit.router)
app.include_router(meetings_ai.router)
app.include_router(translate.router)
app.include_router(email_share.router)
app.include_router(sessions.router)

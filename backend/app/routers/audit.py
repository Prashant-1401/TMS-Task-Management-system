import os
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from app.database import get_db
from app.models.models import Audit
from app.schemas.schemas import AuditCreate
from app.middleware.auth import require_api_key

router = APIRouter(prefix="/api/audit", tags=["Audit"], dependencies=[Depends(require_api_key)])


@router.get("/")
async def list_audit(
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Audit", use_cache=True)
        # Sort by ts desc if available
        try:
            rows = sorted(rows, key=lambda x: x.get("ts") or "", reverse=True)
        except Exception:
            pass
        skip = max(0, skip)
        limit = max(1, min(limit, 500))
        rows = rows[skip:skip+limit]
        return rows
    skip = max(0, skip)
    limit = max(1, min(limit, 500))
    result = await db.execute(select(Audit).order_by(Audit.ts.desc()).offset(skip).limit(limit))
    return result.scalars().all()


@router.post("/")
async def create_audit_entry(data: AuditCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create, sheets_get_by_id
        # Check unique constraint action_sn + level (Audit has UniqueConstraint)
        # If duplicate, mimic Postgres IntegrityError behavior: return skipped
        existing = None
        try:
            # Check if id already exists
            existing = sheets_get_by_id("Audit", data.id)
        except Exception:
            pass
        if existing:
            return {"ok": True, "skipped": True}
        row = sheets_create("Audit", data.model_dump())
        if not row:
            return {"ok": True, "skipped": True}
        return row
    entry = Audit(**data.model_dump())
    db.add(entry)
    try:
        await db.commit()
        await db.refresh(entry)
    except IntegrityError:
        await db.rollback()
        return {"ok": True, "skipped": True}
    return entry


@router.post("/batch")
async def batch_audit(entries: list[AuditCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        # For Sheets, bulk upsert with skip on duplicates - count created vs skipped
        # sheets_bulk_upsert returns inserted/updated, we approximate created as upserted
        # To mimic original which tries to insert all and rolls back on IntegrityError,
        # for Sheets we just upsert and report.
        rows = [e.model_dump() for e in entries]
        result = sheets_bulk_upsert("Audit", rows)
        created = result.get("upserted", 0)
        skipped = len(entries) - created if created < len(entries) else 0
        return {"ok": True, "created": created, "skipped": skipped}
    created = 0
    skipped = 0
    for data in entries:
        entry = Audit(**data.model_dump())
        db.add(entry)
        created += 1
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        skipped = len(entries)
        created = 0
    return {"ok": True, "created": created, "skipped": skipped}


@router.post("/bulk")
async def bulk_upsert_audit(rows: list[AuditCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        result = sheets_bulk_upsert("Audit", [r.model_dump() for r in rows])
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        result = await db.execute(select(Audit).where(Audit.id == data.id))
        existing = result.scalar_one_or_none()
        if existing:
            for k, v in data.model_dump(exclude_unset=True).items():
                setattr(existing, k, v)
        else:
            db.add(Audit(**data.model_dump()))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

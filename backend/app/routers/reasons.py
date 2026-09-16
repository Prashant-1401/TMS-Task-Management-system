import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.models import Reason
from app.schemas.schemas import ReasonCreate, ReasonUpdate
from app.middleware.auth import require_api_key

router = APIRouter(prefix="/api/reasons", tags=["Reasons"], dependencies=[Depends(require_api_key)])


@router.get("/")
async def list_reasons(category: str = None, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Reasons", use_cache=True)
        if category:
            rows = [r for r in rows if r.get("category") == category]
        return rows
    q = select(Reason)
    if category:
        q = q.where(Reason.category == category)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{reason_id}")
async def get_reason(reason_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id
        row = sheets_get_by_id("Reasons", reason_id)
        if not row:
            raise HTTPException(status_code=404, detail="Reason not found")
        return row
    result = await db.execute(select(Reason).where(Reason.id == reason_id))
    reason = result.scalar_one_or_none()
    if not reason:
        raise HTTPException(status_code=404, detail="Reason not found")
    return reason


@router.post("/")
async def create_reason(data: ReasonCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create
        row = sheets_create("Reasons", data.model_dump())
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create reason in Sheets")
        return row
    reason = Reason(**data.model_dump())
    db.add(reason)
    await db.commit()
    await db.refresh(reason)
    return reason


@router.patch("/{reason_id}")
async def update_reason(reason_id: str, data: ReasonUpdate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_update
        row = sheets_update("Reasons", reason_id, data.model_dump(exclude_unset=True))
        if not row:
            raise HTTPException(status_code=404, detail="Reason not found")
        return row
    result = await db.execute(select(Reason).where(Reason.id == reason_id))
    reason = result.scalar_one_or_none()
    if not reason:
        raise HTTPException(status_code=404, detail="Reason not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(reason, k, v)
    await db.commit()
    await db.refresh(reason)
    return reason


@router.delete("/{reason_id}")
async def delete_reason(reason_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_delete
        if not sheets_delete("Reasons", reason_id):
            raise HTTPException(status_code=404, detail="Reason not found")
        return {"ok": True}
    result = await db.execute(select(Reason).where(Reason.id == reason_id))
    reason = result.scalar_one_or_none()
    if not reason:
        raise HTTPException(status_code=404, detail="Reason not found")
    await db.delete(reason)
    await db.commit()
    return {"ok": True}

@router.post("/bulk")
async def bulk_upsert_reasons(rows: list[ReasonCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        result = sheets_bulk_upsert("Reasons", [r.model_dump() for r in rows])
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        result = await db.execute(select(Reason).where(Reason.id == data.id))
        existing = result.scalar_one_or_none()
        if existing:
            for k, v in data.model_dump(exclude_unset=True).items():
                setattr(existing, k, v)
        else:
            db.add(Reason(**data.model_dump()))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

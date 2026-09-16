import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.models import Role
from app.schemas.schemas import RoleCreate, RoleUpdate
from app.middleware.auth import require_api_key

router = APIRouter(prefix="/api/roles", tags=["Roles"], dependencies=[Depends(require_api_key)])


@router.get("/")
async def list_roles(db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Roles", use_cache=True)
        return rows
    result = await db.execute(select(Role))
    return result.scalars().all()


@router.get("/{role_id}")
async def get_role(role_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id
        row = sheets_get_by_id("Roles", role_id)
        if not row:
            raise HTTPException(status_code=404, detail="Role not found")
        return row
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    return role


@router.post("/")
async def create_role(data: RoleCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create
        row = sheets_create("Roles", data.model_dump())
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create role in Sheets")
        return row
    role = Role(**data.model_dump())
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return role


@router.patch("/{role_id}")
async def update_role(role_id: str, data: RoleUpdate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_update
        row = sheets_update("Roles", role_id, data.model_dump(exclude_unset=True))
        if not row:
            raise HTTPException(status_code=404, detail="Role not found")
        return row
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(role, k, v)
    await db.commit()
    await db.refresh(role)
    return role


@router.delete("/{role_id}")
async def delete_role(role_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_delete
        if not sheets_delete("Roles", role_id):
            raise HTTPException(status_code=404, detail="Role not found")
        return {"ok": True}
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    await db.delete(role)
    await db.commit()
    return {"ok": True}


@router.post("/bulk")
async def bulk_upsert_roles(rows: list[RoleCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        result = sheets_bulk_upsert("Roles", [r.model_dump() for r in rows])
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        result = await db.execute(select(Role).where(Role.id == data.id))
        existing = result.scalar_one_or_none()
        if existing:
            for k, v in data.model_dump(exclude_unset=True).items():
                setattr(existing, k, v)
        else:
            db.add(Role(**data.model_dump()))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.models import Machine
from app.schemas.schemas import MachineCreate, MachineUpdate
from app.middleware.auth import require_api_key, get_current_user
from app.services.plant_scoping import scope_by_plant

router = APIRouter(prefix="/api/machines", tags=["Machines"], dependencies=[Depends(require_api_key)])


@router.get("/")
async def list_machines(plant_id: str = None, dept_id: str = None, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Machines", use_cache=True)
        if plant_id:
            rows = [r for r in rows if r.get("plant_id") == plant_id]
        if dept_id:
            rows = [r for r in rows if r.get("dept_id") == dept_id]
        # Plant scoping
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id:
                rows = [r for r in rows if r.get("plant_id") == c_plant_id]
        return rows
    q = select(Machine)
    if plant_id:
        q = q.where(Machine.plant_id == plant_id)
    if dept_id:
        q = q.where(Machine.dept_id == dept_id)
    q = scope_by_plant(q, current_user, Machine.plant_id)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{machine_id}")
async def get_machine(machine_id: str, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id
        row = sheets_get_by_id("Machines", machine_id)
        if not row:
            raise HTTPException(status_code=404, detail="Machine not found")
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id and row.get("plant_id") != c_plant_id:
                raise HTTPException(status_code=404, detail="Machine not found")
        return row
    q = scope_by_plant(select(Machine), current_user, Machine.plant_id)
    q = q.where(Machine.id == machine_id)
    result = await db.execute(q)
    machine = result.scalar_one_or_none()
    if not machine:
        raise HTTPException(status_code=404, detail="Machine not found")
    return machine


@router.post("/")
async def create_machine(data: MachineCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create
        row = sheets_create("Machines", data.model_dump())
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create machine in Sheets")
        return row
    machine = Machine(**data.model_dump())
    db.add(machine)
    await db.commit()
    await db.refresh(machine)
    return machine


@router.patch("/{machine_id}")
async def update_machine(machine_id: str, data: MachineUpdate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_update
        row = sheets_update("Machines", machine_id, data.model_dump(exclude_unset=True))
        if not row:
            raise HTTPException(status_code=404, detail="Machine not found")
        return row
    result = await db.execute(select(Machine).where(Machine.id == machine_id))
    machine = result.scalar_one_or_none()
    if not machine:
        raise HTTPException(status_code=404, detail="Machine not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(machine, k, v)
    await db.commit()
    await db.refresh(machine)
    return machine


@router.delete("/{machine_id}")
async def delete_machine(machine_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_delete
        if not sheets_delete("Machines", machine_id):
            raise HTTPException(status_code=404, detail="Machine not found")
        return {"ok": True}
    result = await db.execute(select(Machine).where(Machine.id == machine_id))
    machine = result.scalar_one_or_none()
    if not machine:
        raise HTTPException(status_code=404, detail="Machine not found")
    await db.delete(machine)
    await db.commit()
    return {"ok": True}


@router.post("/bulk")
async def bulk_upsert_machines(rows: list[MachineCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        result = sheets_bulk_upsert("Machines", [r.model_dump() for r in rows])
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        result = await db.execute(select(Machine).where(Machine.id == data.id))
        existing = result.scalar_one_or_none()
        if existing:
            for k, v in data.model_dump(exclude_unset=True).items():
                setattr(existing, k, v)
        else:
            db.add(Machine(**data.model_dump()))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.models import Department
from app.schemas.schemas import DepartmentCreate, DepartmentUpdate
from app.middleware.auth import require_api_key, get_current_user
from app.services.plant_scoping import scope_by_plant

router = APIRouter(prefix="/api/departments", tags=["Departments"], dependencies=[Depends(require_api_key)])


@router.get("/")
async def list_departments(plant_id: str = None, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Departments", use_cache=True)
        if plant_id:
            rows = [r for r in rows if r.get("plant_id") == plant_id]
        # Plant scoping for Sheets
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id:
                rows = [r for r in rows if r.get("plant_id") == c_plant_id]
        return rows
    q = select(Department)
    if plant_id:
        q = q.where(Department.plant_id == plant_id)
    q = scope_by_plant(q, current_user, Department.plant_id)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{dept_id}")
async def get_department(dept_id: str, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id
        row = sheets_get_by_id("Departments", dept_id)
        if not row:
            raise HTTPException(status_code=404, detail="Department not found")
        # Plant scoping
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id and row.get("plant_id") != c_plant_id:
                raise HTTPException(status_code=404, detail="Department not found")
        return row
    q = scope_by_plant(select(Department), current_user, Department.plant_id)
    q = q.where(Department.id == dept_id)
    result = await db.execute(q)
    dept = result.scalar_one_or_none()
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    return dept


@router.post("/")
async def create_department(data: DepartmentCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create
        row = sheets_create("Departments", data.model_dump())
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create department in Sheets")
        return row
    dept = Department(**data.model_dump())
    db.add(dept)
    await db.commit()
    await db.refresh(dept)
    return dept


@router.patch("/{dept_id}")
async def update_department(dept_id: str, data: DepartmentUpdate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_update
        row = sheets_update("Departments", dept_id, data.model_dump(exclude_unset=True))
        if not row:
            raise HTTPException(status_code=404, detail="Department not found")
        return row
    result = await db.execute(select(Department).where(Department.id == dept_id))
    dept = result.scalar_one_or_none()
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(dept, k, v)
    await db.commit()
    await db.refresh(dept)
    return dept


@router.delete("/{dept_id}")
async def delete_department(dept_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_delete
        if not sheets_delete("Departments", dept_id):
            raise HTTPException(status_code=404, detail="Department not found")
        return {"ok": True}
    result = await db.execute(select(Department).where(Department.id == dept_id))
    dept = result.scalar_one_or_none()
    if not dept:
        raise HTTPException(status_code=404, detail="Department not found")
    await db.delete(dept)
    await db.commit()
    return {"ok": True}


@router.post("/bulk")
async def bulk_upsert_departments(rows: list[DepartmentCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        result = sheets_bulk_upsert("Departments", [r.model_dump() for r in rows])
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        result = await db.execute(select(Department).where(Department.id == data.id))
        existing = result.scalar_one_or_none()
        if existing:
            for k, v in data.model_dump(exclude_unset=True).items():
                setattr(existing, k, v)
        else:
            db.add(Department(**data.model_dump()))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

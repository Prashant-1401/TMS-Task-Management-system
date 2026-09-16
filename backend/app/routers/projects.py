import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import datetime
from app.database import get_db
from app.models.models import Project
from app.schemas.schemas import ProjectCreate, ProjectUpdate
from app.middleware.auth import require_api_key, get_current_user
from app.services.plant_scoping import scope_by_plant

router = APIRouter(prefix="/api/projects", tags=["Projects"], dependencies=[Depends(require_api_key)])

DATE_FIELDS = {"start_date", "end_date"}


@router.get("/")
async def list_projects(plant_id: str = None, status: str = None, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        rows = sheets_get_all("Projects", use_cache=True)
        if plant_id:
            rows = [r for r in rows if r.get("plant_id") == plant_id]
        if status:
            rows = [r for r in rows if r.get("status") == status]
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id:
                rows = [r for r in rows if r.get("plant_id") == c_plant_id]
        return rows
    q = select(Project)
    if plant_id:
        q = q.where(Project.plant_id == plant_id)
    if status:
        q = q.where(Project.status == status)
    q = scope_by_plant(q, current_user, Project.plant_id)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{project_id}")
async def get_project(project_id: str, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id
        row = sheets_get_by_id("Projects", project_id)
        if not row:
            raise HTTPException(status_code=404, detail="Project not found")
        if current_user and not current_user.get("is_admin"):
            c_plant_id = current_user.get("plant_id")
            if c_plant_id and row.get("plant_id") != c_plant_id:
                raise HTTPException(status_code=404, detail="Project not found")
        return row
    q = scope_by_plant(select(Project), current_user, Project.plant_id)
    q = q.where(Project.id == project_id)
    result = await db.execute(q)
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.post("/")
async def create_project(data: ProjectCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create
        payload = data.model_dump()
        # Sheets stores dates as strings; keep as is or convert date strings
        row = sheets_create("Projects", payload)
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create project in Sheets")
        return row
    payload = data.model_dump()
    for k in DATE_FIELDS:
        if k in payload and isinstance(payload[k], str):
            try:
                payload[k] = datetime.date.fromisoformat(payload[k])
            except (ValueError, TypeError):
                payload[k] = None
    project = Project(**payload)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@router.patch("/{project_id}")
async def update_project(project_id: str, data: ProjectUpdate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_update
        row = sheets_update("Projects", project_id, data.model_dump(exclude_unset=True))
        if not row:
            raise HTTPException(status_code=404, detail="Project not found")
        return row
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        if k in DATE_FIELDS and isinstance(v, str):
            try:
                v = datetime.date.fromisoformat(v)
            except (ValueError, TypeError):
                v = None
        setattr(project, k, v)
    await db.commit()
    await db.refresh(project)
    return project


@router.delete("/{project_id}")
async def delete_project(project_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_delete
        if not sheets_delete("Projects", project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        return {"ok": True}
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    await db.delete(project)
    await db.commit()
    return {"ok": True}


@router.post("/bulk")
async def bulk_upsert_projects(rows: list[ProjectCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        result = sheets_bulk_upsert("Projects", [r.model_dump() for r in rows])
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        result = await db.execute(select(Project).where(Project.id == data.id))
        existing = result.scalar_one_or_none()
        payload = data.model_dump()
        for k in DATE_FIELDS:
            if k in payload and isinstance(payload[k], str):
                try:
                    payload[k] = datetime.date.fromisoformat(payload[k])
                except (ValueError, TypeError):
                    payload[k] = None
        if existing:
            for k, v in payload.items():
                if k in DATE_FIELDS and isinstance(v, str):
                    try:
                        v = datetime.date.fromisoformat(v)
                    except (ValueError, TypeError):
                        v = None
                setattr(existing, k, v)
        else:
            db.add(Project(**payload))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

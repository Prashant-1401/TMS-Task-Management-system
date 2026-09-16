from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.models import Plant
from app.schemas.schemas import PlantCreate, PlantUpdate
from app.middleware.auth import require_api_key, get_current_user
from app.services.plant_scoping import scope_by_plant
import os

router = APIRouter(prefix="/api/plants", tags=["Plants"], dependencies=[Depends(require_api_key)])


@router.get("/")
async def list_plants(db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_all
        # Sheets-as-DB: return all plants, filtered by plant scoping if needed
        rows = sheets_get_all("Plants", use_cache=True)
        # Simple plant scoping for Sheets
        if current_user and not current_user.get("is_admin"):
            plant_id = current_user.get("plant_id")
            if plant_id:
                rows = [r for r in rows if r.get("id") == plant_id or r.get("plant_id") == plant_id]
        return rows
    q = scope_by_plant(select(Plant), current_user, Plant.id)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{plant_id}")
async def get_plant(plant_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_get_by_id
        row = sheets_get_by_id("Plants", plant_id)
        if not row:
            raise HTTPException(status_code=404, detail="Plant not found")
        return row
    result = await db.execute(select(Plant).where(Plant.id == plant_id))
    plant = result.scalar_one_or_none()
    if not plant:
        raise HTTPException(status_code=404, detail="Plant not found")
    return plant


@router.post("/")
async def create_plant(data: PlantCreate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_create
        row = sheets_create("Plants", data.model_dump())
        if not row:
            raise HTTPException(status_code=400, detail="Failed to create plant in Sheets")
        return row
    plant = Plant(**data.model_dump())
    db.add(plant)
    await db.commit()
    await db.refresh(plant)
    return plant


@router.patch("/{plant_id}")
async def update_plant(plant_id: str, data: PlantUpdate, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_update
        row = sheets_update("Plants", plant_id, data.model_dump(exclude_unset=True))
        if not row:
            raise HTTPException(status_code=404, detail="Plant not found")
        return row
    result = await db.execute(select(Plant).where(Plant.id == plant_id))
    plant = result.scalar_one_or_none()
    if not plant:
        raise HTTPException(status_code=404, detail="Plant not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(plant, k, v)
    await db.commit()
    await db.refresh(plant)
    return plant



@router.delete("/{plant_id}")
async def delete_plant(plant_id: str, db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_delete
        if not sheets_delete("Plants", plant_id):
            raise HTTPException(status_code=404, detail="Plant not found")
        return {"ok": True}
    result = await db.execute(select(Plant).where(Plant.id == plant_id))
    plant = result.scalar_one_or_none()
    if not plant:
        raise HTTPException(status_code=404, detail="Plant not found")
    await db.delete(plant)
    await db.commit()
    return {"ok": True}


@router.post("/bulk")
async def bulk_upsert_plants(rows: list[PlantCreate], db: AsyncSession = Depends(get_db)):
    if os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes"):
        from app.services.sheets_db_service import sheets_bulk_upsert
        result = sheets_bulk_upsert("Plants", [r.model_dump() for r in rows])
        return {"ok": True, "upserted": result.get("upserted", 0)}
    upserted = 0
    for data in rows:
        result = await db.execute(select(Plant).where(Plant.id == data.id))
        existing = result.scalar_one_or_none()
        if existing:
            for k, v in data.model_dump(exclude_unset=True).items():
                setattr(existing, k, v)
        else:
            db.add(Plant(**data.model_dump()))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

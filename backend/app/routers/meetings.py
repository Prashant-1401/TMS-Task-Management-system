from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import datetime
from app.database import get_db
from app.models.models import Meeting, MeetingPreset
from app.schemas.schemas import MeetingCreate, MeetingUpdate, MeetingPresetCreate, MeetingPresetUpdate
from app.middleware.auth import require_api_key, get_current_user
from app.services.plant_scoping import scope_by_plant

router = APIRouter(prefix="/api/meetings", tags=["Meetings"], dependencies=[Depends(require_api_key)])

DATE_FIELDS = {"date"}

# ── Presets (must be before /{meeting_id} to avoid shadowing) ──

@router.get("/presets")
async def list_meeting_presets(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MeetingPreset))
    return result.scalars().all()


@router.post("/presets/bulk")
async def bulk_upsert_meeting_presets(rows: list[MeetingPresetCreate], db: AsyncSession = Depends(get_db)):
    upserted = 0
    for data in rows:
        result = await db.execute(select(MeetingPreset).where(MeetingPreset.type == data.type))
        existing = result.scalar_one_or_none()
        if existing:
            for k, v in data.model_dump(exclude_unset=True).items():
                setattr(existing, k, v)
        else:
            db.add(MeetingPreset(**data.model_dump()))
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}


@router.post("/presets")
async def create_meeting_preset(data: MeetingPresetCreate, db: AsyncSession = Depends(get_db)):
    preset = MeetingPreset(**data.model_dump())
    db.add(preset)
    await db.commit()
    await db.refresh(preset)
    return preset


@router.patch("/presets/{preset_type}")
async def update_meeting_preset(preset_type: str, data: MeetingPresetUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MeetingPreset).where(MeetingPreset.type == preset_type))
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(status_code=404, detail="Meeting preset not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(preset, k, v)
    await db.commit()
    await db.refresh(preset)
    return preset


@router.delete("/presets/{preset_type}")
async def delete_meeting_preset(preset_type: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MeetingPreset).where(MeetingPreset.type == preset_type))
    preset = result.scalar_one_or_none()
    if not preset:
        raise HTTPException(status_code=404, detail="Meeting preset not found")
    await db.delete(preset)
    await db.commit()
    return {"ok": True}


# ── Meetings ──

@router.get("/")
async def list_meetings(
    plant_id: str = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    skip = max(0, skip)
    limit = max(1, min(limit, 500))
    q = select(Meeting)
    if plant_id:
        q = q.where(Meeting.plant_id == plant_id)
    q = scope_by_plant(q, current_user, Meeting.plant_id)
    q = q.order_by(Meeting.date.desc()).offset(skip).limit(limit)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{meeting_id}")
async def get_meeting(meeting_id: str, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    q = scope_by_plant(select(Meeting), current_user, Meeting.plant_id)
    q = q.where(Meeting.id == meeting_id)
    result = await db.execute(q)
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return meeting


@router.post("/")
async def create_meeting(data: MeetingCreate, db: AsyncSession = Depends(get_db)):
    payload = data.model_dump()
    for k in DATE_FIELDS:
        if k in payload and isinstance(payload[k], str):
            try:
                payload[k] = datetime.date.fromisoformat(payload[k])
            except (ValueError, TypeError):
                payload[k] = None
    meeting = Meeting(**payload)
    db.add(meeting)
    await db.commit()
    await db.refresh(meeting)
    return meeting


@router.patch("/{meeting_id}")
async def update_meeting(meeting_id: str, data: MeetingUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        if k in DATE_FIELDS and isinstance(v, str):
            try:
                v = datetime.date.fromisoformat(v)
            except (ValueError, TypeError):
                v = None
        setattr(meeting, k, v)
    await db.commit()
    await db.refresh(meeting)
    return meeting


@router.delete("/{meeting_id}")
async def delete_meeting(meeting_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Meeting).where(Meeting.id == meeting_id))
    meeting = result.scalar_one_or_none()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    await db.delete(meeting)
    await db.commit()
    return {"ok": True}

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from app.database import get_db
from app.models.models import User
from app.schemas.schemas import UserCreate, UserUpdate
from app.services.email_service import send_welcome_email
from app.services.password import hash_password
from app.middleware.auth import require_api_key, get_current_user
from app.services.plant_scoping import scope_by_plant

router = APIRouter(prefix="/api/users", tags=["Users"], dependencies=[Depends(require_api_key)])


class UserResponse(BaseModel):
    id: str
    name: str
    username: str
    role: Optional[str] = None
    plant_id: Optional[str] = None
    dept_id: Optional[str] = None
    superior: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    initials: Optional[str] = None
    color: Optional[str] = None
    is_active: Optional[bool] = True
    master_access: Optional[bool] = False

    class Config:
        from_attributes = True


def _safe_user(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        name=user.name,
        username=user.username,
        role=user.role,
        plant_id=user.plant_id,
        dept_id=user.dept_id,
        superior=user.superior,
        phone=user.phone,
        email=user.email,
        initials=user.initials,
        color=user.color,
        is_active=user.is_active,
        master_access=getattr(user, 'master_access', False),
    )


@router.get("/")
async def list_users(
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    skip = max(0, skip)
    limit = max(1, min(limit, 500))
    q = scope_by_plant(select(User), current_user, User.plant_id).offset(skip).limit(limit)
    result = await db.execute(q)
    users = result.scalars().all()
    return [_safe_user(u) for u in users]


@router.get("/{user_id}")
async def get_user(user_id: str, db: AsyncSession = Depends(get_db), current_user: dict = Depends(get_current_user)):
    q = scope_by_plant(select(User), current_user, User.plant_id)
    q = q.where(User.id == user_id)
    result = await db.execute(q)
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return _safe_user(user)


@router.post("/")
async def create_user(data: UserCreate, db: AsyncSession = Depends(get_db), bg: BackgroundTasks = None):
    existing = await db.execute(select(User).where(User.username == data.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already exists")
    user_data = data.model_dump()
    plain_password = user_data.get("password") or ""
    if user_data.get("password"):
        user_data["password"] = hash_password(user_data["password"])
    else:
        user_data["password"] = None
    user = User(**user_data)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    if user.email:
        if bg:
            bg.add_task(send_welcome_email, user.name, user.username, user.email,
                        plain_password, user.superior, user.phone)
        else:
            send_welcome_email(user.name, user.username, user.email,
                                plain_password, user.superior, user.phone)
    return _safe_user(user)


@router.patch("/{user_id}")
async def update_user(user_id: str, data: UserUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    update_data = data.model_dump(exclude_unset=True)
    if update_data.get("password"):
        update_data["password"] = hash_password(update_data["password"])
    for k, v in update_data.items():
        setattr(user, k, v)
    await db.commit()
    await db.refresh(user)
    return _safe_user(user)


@router.delete("/{user_id}")
async def delete_user(user_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await db.delete(user)
    await db.commit()
    return {"ok": True}


@router.post("/bulk")
async def bulk_upsert_users(rows: list[UserCreate], db: AsyncSession = Depends(get_db), bg: BackgroundTasks = None):
    upserted = 0
    for data in rows:
        result = await db.execute(select(User).where(User.id == data.id))
        existing = result.scalar_one_or_none()
        if existing:
            update_data = data.model_dump(exclude_unset=True)
            if update_data.get("password"):
                update_data["password"] = hash_password(update_data["password"])
            for k, v in update_data.items():
                setattr(existing, k, v)
        else:
            user_data = data.model_dump()
            plain_password = user_data.get("password") or ""
            if user_data.get("password"):
                user_data["password"] = hash_password(user_data["password"])
            else:
                user_data["password"] = None
            db.add(User(**user_data))
            if data.email:
                if bg:
                    bg.add_task(send_welcome_email, data.name, data.username, data.email,
                                plain_password, data.superior, data.phone)
                else:
                    send_welcome_email(data.name, data.username, data.email,
                                        plain_password, data.superior, data.phone)
        upserted += 1
    await db.commit()
    return {"ok": True, "upserted": upserted}

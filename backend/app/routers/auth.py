from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.database import get_db
from app.models.models import User
from app.schemas.schemas import LoginRequest
from app.middleware.auth import create_token, decode_token
from app.routers.sessions import register_session, revoke_session
from app.services.password import verify_password
from app.config import settings

router = APIRouter(prefix="/api/auth", tags=["Auth"])


@router.post("/login")
async def login(req: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).where(func.lower(User.username) == req.username.strip().lower())
    )
    user = result.scalar_one_or_none()
    if not user or not user.password or not verify_password(req.password, user.password):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    user_data = {
        "id": user.id,
        "name": user.name,
        "username": user.username,
        "role": user.role,
        "plant": user.plant_id,
        "dept": user.dept_id,
        "initials": user.initials or user.name[:2].upper(),
        "color": user.color or "#7C80B0",
        "phone": user.phone,
        "email": user.email,
        "superior": user.superior,
        "masterAccess": getattr(user, 'master_access', False),
    }
    token = create_token({"sub": user.username, "role": user.role, "id": user.id})
    # Register this device session (best-effort, never block login)
    try:
        await register_session(request, token, user.username)
    except Exception as e:
        print(f"[sessions] register failed: {e}")
    return {"token": token, "user": user_data}


@router.post("/master-login")
async def master_login(req: LoginRequest):
    if not settings.master_user or not settings.master_password:
        raise HTTPException(status_code=403, detail="Master login not configured")
    if req.username.strip().lower() != settings.master_user.lower() or req.password != settings.master_password:
        raise HTTPException(status_code=401, detail="Invalid master credentials")
    token = create_token({"sub": "master", "role": "Admin", "id": "MASTER"})
    user_data = {
        "id": "MASTER",
        "name": "Master Admin",
        "username": "master",
        "role": "Admin",
        "plant": "All",
        "dept": "Management",
        "initials": "MA",
        "color": "#272262",
        "isMaster": True,
        "masterAccess": True,
    }
    return {"token": token, "user": user_data}


@router.post("/logout")
async def logout(request: Request):
    auth = request.headers.get("authorization", "")
    token = auth.replace("Bearer ", "") if auth.lower().startswith("bearer ") else None
    try:
        await revoke_session(token)
    except Exception as e:
        print(f"[sessions] revoke failed: {e}")
    return {"ok": True}

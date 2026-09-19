from fastapi import Depends, HTTPException, Header
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
import jwt
import uuid as _uuid
from app.config import settings

security = HTTPBearer(auto_error=False)


def create_token(payload: dict) -> str:
    import datetime
    to_encode = payload.copy()
    expire = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=settings.jwt_expire_minutes)
    to_encode.update({"exp": expire, "jti": str(_uuid.uuid4())})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def require_auth(credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)):
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return decode_token(credentials.credentials)


async def optional_auth(credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)):
    if credentials is None:
        return None
    try:
        return decode_token(credentials.credentials)
    except Exception:
        return None


async def require_api_key(
    x_api_key: Optional[str] = Header(None),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
):
    # If API key is configured, validate it
    if settings.api_key:
        if x_api_key == settings.api_key:
            return None
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    # No API key configured — fall back to JWT auth so endpoints are never open
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return decode_token(credentials.credentials)


async def get_current_user(
    x_api_key: Optional[str] = Header(None),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
):
    """Extract user identity from JWT. Returns user dict with id, name, username, role, email, plant_id, is_admin."""
    if credentials is not None:
        try:
            payload = decode_token(credentials.credentials)
            from app.database import async_session
            from app.models.models import User
            from sqlalchemy import select
            async with async_session() as db:
                result = await db.execute(select(User).where(User.username == payload.get("sub")))
                user = result.scalar_one_or_none()
                if not user:
                    return payload
                return {
                    "id": user.id,
                    "name": user.name,
                    "username": user.username,
                    "role": user.role,
                    "email": user.email,
                    "plant_id": user.plant_id,
                    "is_admin": user.role == "Admin" or getattr(user, "master_access", False),
                }
        except Exception:
            pass

    if settings.api_key and x_api_key == settings.api_key:
        return {
            "id": "api-key",
            "name": "Admin",
            "username": "admin",
            "role": "Admin",
            "email": "",
            "plant_id": None,
            "is_admin": True,
        }

    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return None

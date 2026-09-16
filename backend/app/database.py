from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.config import settings
import os

# Sheets-as-DB mode: no Postgres needed, use dummy in-memory SQLite for SQLAlchemy models
# All CRUD goes via sheets_db_service when USE_GOOGLE_SHEETS_AS_DB=true
_is_sheets = os.getenv("USE_GOOGLE_SHEETS_AS_DB", "").lower() in ("1", "true", "yes") or getattr(settings, "use_google_sheets_as_db", False)
_db_url = settings.database_url.strip() if settings.database_url else ""

if _is_sheets and not _db_url:
    # Sheets primary: use dummy SQLite (never actually queried, but keeps SQLAlchemy happy)
    _db_url = "sqlite+aiosqlite:///:memory:"
    print("[database] Sheets primary mode — using dummy SQLite (Postgres not required)")

if not _db_url:
    _db_url = "sqlite+aiosqlite:///:memory:"
    print("[database] No DATABASE_URL — using dummy SQLite")

# SQLite doesn't support pool args, so branch
if _db_url.startswith("sqlite"):
    engine = create_async_engine(_db_url, echo=False)
else:
    engine = create_async_engine(
        _db_url,
        pool_size=20,
        max_overflow=30,
        echo=False,
        pool_pre_ping=True,
        pool_recycle=300,
        connect_args={"command_timeout": 15} if "asyncpg" in _db_url else {},
    )

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        yield session

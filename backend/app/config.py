import os
from pydantic_settings import BaseSettings

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Settings(BaseSettings):
    database_url: str = ""  # Optional when USE_GOOGLE_SHEETS_AS_DB=true (Sheets primary, no Postgres needed)
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash-lite"
    secret_key: str = "change-me-to-a-random-secret"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 480
    allowed_origins: str = "*"
    api_key: str = ""
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    admin_email: str = "admin@adroit.in"
    team_email: str = "team@adroit.in"
    wacrm_alert_url: str = ""
    frontend_url: str = "https://tms-control-management.vercel.app"
    master_user: str = ""
    master_password: str = ""
    google_sheets_credentials_path: str = ""
    google_sheets_spreadsheet_id: str = ""
    google_sheets_worksheet_name: str = "Actions"
    use_google_sheets_as_db: bool = False  # Set true to use Google Sheets as primary DB (instead of Postgres)

    class Config:
        env_file = os.path.join(_BACKEND_DIR, ".env")
        env_file_encoding = "utf-8"


settings = Settings()

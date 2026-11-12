from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "dev"
    app_name: str = "UoM Learning"
    database_url: str = "postgresql+asyncpg://uom:uom@db:5432/uom"
    redis_url: str = "redis://redis:6379/0"
    jwt_secret: str = "change-me-in-production-please-32b"
    jwt_ttl_minutes: int = 60 * 8
    cookie_secure: bool = False
    cors_origins: str = ""

    anthropic_api_key: str | None = None
    event_update_hold_min: int = 10  # automatic date/time update waits this long after the last edit
    newsletter_anthropic_key: str | None = None  # separate key for the weekly brief; always calls api.anthropic.com directly
    llm_model: str = "claude-opus-5-5"
    llm_effort: str = "low"
    llm_timeout_s: float = 20.0
    evaluation_engine: str = "auto"  # auto | claude | rubric

    media_dir: str = "/data/media"
    assets_dir: str = "/app/assets"
    fal_key: str | None = None

    login_rate_per_min: int = 10

    # Outgoing email (webinar updates + newsletter). Hostinger: smtp.hostinger.com, port 465 (SSL).
    smtp_host: str | None = None
    smtp_port: int = 465
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_starttls: bool = False  # True for port 587
    mail_from_email: str | None = None  # defaults to smtp_user
    mail_from_name: str = "Hibilter IT Systems & TuQuant"
    mail_reply_to: str | None = None
    mail_rate_per_min: int = 20
    owner_notify_email: str | None = None  # gets "newsletter drafts ready" notices
    public_base_url: str = "https://learn.34-14-150-134.sslip.io"
    newsletter_llm_model: str = "claude-sonnet-5-5"
    newsletter_weekday: int = 0  # Monday
    newsletter_hour_utc: int = 4  # 08:00 Mauritius / 09:30 India


@lru_cache
def get_settings() -> Settings:
    return Settings()

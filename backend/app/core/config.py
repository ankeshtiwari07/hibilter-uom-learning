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
    llm_model: str = "claude-opus-5-5"
    llm_effort: str = "low"
    llm_timeout_s: float = 20.0
    evaluation_engine: str = "auto"  # auto | claude | rubric

    media_dir: str = "/data/media"
    assets_dir: str = "/app/assets"
    fal_key: str | None = None

    login_rate_per_min: int = 10


@lru_cache
def get_settings() -> Settings:
    return Settings()

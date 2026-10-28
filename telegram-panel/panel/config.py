"""Environment settings. Step-specific values are optional here and checked where they're used."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    panel_enc_key: str = Field(min_length=1)
    panel_secret: str = Field(min_length=32)
    data_dir: Path = Path("./data")
    public_origin: str = "http://localhost:5173"

    tg_api_id: int | None = None
    tg_api_hash: str | None = None

    # No default: the portal's address is deployment config (it moved domains once). Unset → outbox idle.
    portal_ingest_url: str | None = None
    portal_ingest_api_key: str | None = None
    portal_ingest_hmac_secret: str | None = None

    capital_license_key: str | None = None

    @field_validator("portal_ingest_url", mode="before")
    @classmethod
    def _ingest_url(cls, v: object) -> object:
        # Only tidied here. A wrong address must never stop the panel (that would take every account
        # offline): PortalConfig.problem keeps the outbox idle and Status says what's wrong.
        if v is None or str(v).strip() == "":
            return None
        return str(v).strip().rstrip("/")

    @field_validator("tg_api_id", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> object:
        return None if v == "" else v

    @property
    def secure_cookies(self) -> bool:
        return self.public_origin.startswith("https://")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "panel.db"

    @property
    def lock_path(self) -> Path:
        return self.data_dir / "panel.lock"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]

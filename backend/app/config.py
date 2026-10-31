
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "CityShield AI"
    database_url: str = (
        "mysql+pymysql://cityshield_app:CHANGE_ME@127.0.0.1:3306/"
        "cityshield?charset=utf8mb4"
    )
    jwt_secret_key: str
    access_token_minutes: int = 30

    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[1] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()

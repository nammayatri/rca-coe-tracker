from functools import cached_property

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://rca:rca@localhost:5432/rca_coe"
    db_schema: str = "rca_coe"

    host: str = "0.0.0.0"
    port: int = 8000
    app_base_url: str = "http://localhost:5173"
    cors_origins: str = "http://localhost:5173"

    admin_emails: str = ""

    dev_fake_email: str = ""
    dev_fake_name: str = ""

    slack_bot_token: str = ""
    slack_signing_secret: str = ""

    app_version: str = "1.0.3"
    app_commit: str = "dev"

    ai_provider: str = "openai"
    ai_model: str = "openai/open-large"
    ai_fast_model: str = "openai/minimaxai/minimax-m2"
    ai_api_key: str = ""
    ai_api_base: str = ""
    ai_max_tokens: int = 2000
    ai_temperature: float = 0.2

    @cached_property
    def admin_email_list(self) -> list[str]:
        return [e.strip().lower() for e in self.admin_emails.split(",") if e.strip()]

    @cached_property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()

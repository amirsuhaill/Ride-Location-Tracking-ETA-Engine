import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    def __init__(self) -> None:
        self.port: int = int(os.environ.get("PORT", "8000"))
        self.environment: str = os.environ.get("ENVIRONMENT", "development")
        self.log_level: str = os.environ.get("LOG_LEVEL", "info")

        self.database_url: str = os.environ.get("DATABASE_URL", "")
        self.redis_url: str = os.environ.get("REDIS_URL", "")
        self.core_service_url: str = os.environ.get("CORE_SERVICE_URL", "")

        self.app_version: str = os.environ.get("APP_VERSION", "0.1.0")
        self.build_version: str = os.environ.get("BUILD_VERSION", "local")


settings = Settings()

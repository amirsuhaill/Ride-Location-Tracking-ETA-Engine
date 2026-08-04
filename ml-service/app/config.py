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

        # Real road-network routing (Phase 15, see docs/osrm-routing.md) — used only by
        # scripts/train_model.py's retraining pipeline, not by live /predict-eta serving (same
        # standalone-module scope as core's Phase 12/14 modules).
        self.osrm_url: str = os.environ.get("OSRM_URL", "")
        self.osrm_timeout_seconds: float = float(os.environ.get("OSRM_TIMEOUT_SECONDS", "2.0"))

        self.app_version: str = os.environ.get("APP_VERSION", "0.1.0")
        self.build_version: str = os.environ.get("BUILD_VERSION", "local")


settings = Settings()

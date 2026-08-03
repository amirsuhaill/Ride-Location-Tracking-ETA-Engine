import time

from fastapi import FastAPI

from app.config import settings

_start_time = time.monotonic()

app = FastAPI(title="ml-service")


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ml-service",
        "uptime": time.monotonic() - _start_time,
        "version": settings.app_version,
        "build": settings.build_version,
    }

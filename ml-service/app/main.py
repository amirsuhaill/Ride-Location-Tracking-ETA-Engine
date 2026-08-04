import time
from datetime import UTC

import pandas as pd
from fastapi import FastAPI, HTTPException, Request

from app.config import settings
from app.logger import logger
from app.ml.features import build_features, haversine_distance_meters
from app.ml.model_store import load_latest_model
from app.ml.schemas import PredictEtaRequest, PredictEtaResponse

_start_time = time.monotonic()

app = FastAPI(title="ml-service")

# Loaded once at process startup, not retrained/reloaded per request — see
# docs/eta-model.md#serving. (None, None) if scripts/train_model.py has never been run yet;
# /predict-eta below handles that explicitly rather than crashing.
_model, _model_metadata = load_latest_model()


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Structured, one-line-per-request logging — the Python-side counterpart to core's
    src/plugins/request-logging.ts, same field names (method/path/statusCode/latencyMs) so a
    combined log stream reads consistently across both services. Replaces uvicorn's own
    plain-text access log (disabled via the Dockerfile CMD's `--no-access-log`), rather than
    running both and getting two differently-shaped lines per request."""
    started = time.perf_counter()
    response = await call_next(request)
    latency_ms = (time.perf_counter() - started) * 1000
    logger.info(
        "request completed",
        extra={
            "fields": {
                "method": request.method,
                "path": request.url.path,
                "statusCode": response.status_code,
                "latencyMs": round(latency_ms, 2),
            }
        },
    )
    return response


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ml-service",
        "uptime": time.monotonic() - _start_time,
        "version": settings.app_version,
        "build": settings.build_version,
        "eta_model_loaded": _model is not None,
        "eta_model_version": _model_metadata["version"] if _model_metadata else None,
    }


@app.post("/predict-eta", response_model=PredictEtaResponse)
def predict_eta(req: PredictEtaRequest) -> PredictEtaResponse:
    if _model is None or _model_metadata is None:
        raise HTTPException(
            status_code=503,
            detail="No ETA model has been trained yet — run scripts/train_model.py first.",
        )

    # A naive (no UTC offset) timestamp is treated as UTC, consistent with how Postgres stores
    # `timestamptz` — matches app/ml/data.py's own normalization for training data.
    timestamp = req.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)

    row = pd.DataFrame(
        [
            {
                "pickup_lat": req.pickup.lat,
                "pickup_lng": req.pickup.lng,
                "dropoff_lat": req.dropoff.lat,
                "dropoff_lng": req.dropoff.lng,
                "requested_at": timestamp,
            }
        ]
    )
    features = build_features(row)
    predicted_seconds = float(_model.predict(features)[0])
    distance_meters = float(
        haversine_distance_meters(req.pickup.lat, req.pickup.lng, req.dropoff.lat, req.dropoff.lng)
    )

    return PredictEtaResponse(
        predicted_duration_seconds=predicted_seconds,
        distance_meters=distance_meters,
        model_version=_model_metadata["version"],
    )

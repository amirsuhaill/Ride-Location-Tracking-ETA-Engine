"""Request/response models for POST /predict-eta. Pydantic v2 rejects out-of-range
lat/lng and unparseable timestamps with a 422 automatically (FastAPI's default validation
exception handler) — no custom validation code needed to satisfy "reject malformed input with a
clear 4xx, not a crash or silently-garbage output"."""

from datetime import datetime

from pydantic import BaseModel, Field


class LatLng(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class PredictEtaRequest(BaseModel):
    pickup: LatLng
    dropoff: LatLng
    # A naive (no offset) timestamp is treated as UTC by app/main.py before feature-building —
    # documented there, not here, since that normalization is serving-time behavior, not a
    # validation rule.
    timestamp: datetime


class PredictEtaResponse(BaseModel):
    predicted_duration_seconds: float
    distance_meters: float
    model_version: str

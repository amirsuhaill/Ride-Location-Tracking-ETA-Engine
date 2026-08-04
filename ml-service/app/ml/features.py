"""Feature engineering shared by both training (scripts/train_model.py) and serving
(app/main.py's /predict-eta) — using the exact same function for both is deliberate: a common,
real ML bug is subtly different feature computation between training and inference ("train/serve
skew"). Every caller of build_features(), batch or single-row, goes through this one function.

Deliberately does NOT use training_trips' ground-truth-construction columns
(time_of_day_multiplier, zone_density_factor, noise_factor) as inputs, even though they're
available in the same table. A real deployment never has those — they're artifacts of how the
Phase 8 simulator built its target, not something derivable from an actual trip request — so
using them here would leak the target's construction mechanism and produce a model that can't
generalize past this synthetic dataset. Every feature below is derived only from what a real
trip request actually provides: pickup, dropoff, and a timestamp. See
docs/eta-model.md for the full rationale.
"""

import numpy as np
import pandas as pd

from app.ml.constants import CITY_CENTER, EARTH_RADIUS_METERS, SIMULATION_TIME_ZONE

FEATURE_COLUMNS = [
    "haversine_distance_m",
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
    "midpoint_distance_from_center_km",
]


def haversine_distance_meters(lat1, lng1, lat2, lng2):
    """Vectorized (numpy-array-friendly) haversine distance in meters — mirrors
    core/src/services/haversine.ts's formula and Earth-radius constant exactly."""
    lat1r = np.radians(lat1)
    lat2r = np.radians(lat2)
    dlat = np.radians(np.subtract(lat2, lat1))
    dlng = np.radians(np.subtract(lng2, lng1))

    a = np.sin(dlat / 2) ** 2 + np.cos(lat1r) * np.cos(lat2r) * np.sin(dlng / 2) ** 2
    c = 2 * np.arcsin(np.sqrt(a))
    return EARTH_RADIUS_METERS * c


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Given a DataFrame with columns pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
    requested_at (tz-aware or naive-UTC), returns a DataFrame of model-ready features, in
    FEATURE_COLUMNS order, with the same index as `df`.

    Time-of-day and day-of-week are cyclically encoded (sin/cos of a fraction-of-period angle)
    rather than passed as raw integers — a raw "hour" feature would make 23:59 and 00:01 look
    maximally far apart to the model, when they're actually a minute apart. Hour uses a
    *fractional* hour (hour + minute/60 + second/3600) for a smooth cycle, rather than the
    integer-hour bucketing the Phase 7 heuristic baseline uses (see app/ml/baselines.py) — that
    coarser bucketing is a deliberate simplification for a heuristic table lookup, not something
    this model needs to reproduce.
    """
    requested_at = pd.to_datetime(df["requested_at"], utc=True)
    local_dt = requested_at.dt.tz_convert(SIMULATION_TIME_ZONE)

    hour_frac = local_dt.dt.hour + local_dt.dt.minute / 60 + local_dt.dt.second / 3600
    hour_angle = 2 * np.pi * hour_frac / 24

    dow = local_dt.dt.dayofweek  # Monday=0 .. Sunday=6
    dow_angle = 2 * np.pi * dow / 7

    pickup_lat = df["pickup_lat"].to_numpy(dtype=float)
    pickup_lng = df["pickup_lng"].to_numpy(dtype=float)
    dropoff_lat = df["dropoff_lat"].to_numpy(dtype=float)
    dropoff_lng = df["dropoff_lng"].to_numpy(dtype=float)

    haversine_m = haversine_distance_meters(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng)

    midpoint_lat = (pickup_lat + dropoff_lat) / 2
    midpoint_lng = (pickup_lng + dropoff_lng) / 2
    center_distance_km = (
        haversine_distance_meters(
            midpoint_lat, midpoint_lng, CITY_CENTER["lat"], CITY_CENTER["lng"]
        )
        / 1000
    )

    features = pd.DataFrame(
        {
            "haversine_distance_m": haversine_m,
            "hour_sin": np.sin(hour_angle).to_numpy(),
            "hour_cos": np.cos(hour_angle).to_numpy(),
            "dow_sin": np.sin(dow_angle).to_numpy(),
            "dow_cos": np.cos(dow_angle).to_numpy(),
            "midpoint_distance_from_center_km": center_distance_km,
        },
        index=df.index,
    )
    return features[FEATURE_COLUMNS]

"""Trivial baseline predictors the trained model is compared against — a bare MAE/RMSE means
nothing on its own; "beats the naive baseline by X%" and "beats the Phase 7 heuristic by Y%" are
what actually establish the model is worth having. See docs/eta-model.md.
"""

import numpy as np
import pandas as pd

from app.ml.constants import DEFAULT_RUSH_HOUR_MULTIPLIER, RUSH_HOUR_TABLE, SIMULATION_TIME_ZONE


def rush_hour_multiplier(hour: int) -> float:
    """Mirrors core/src/services/eta-heuristic.ts#getRushHourMultiplier exactly (start-inclusive,
    end-exclusive integer-hour windows)."""
    for start, end, multiplier in RUSH_HOUR_TABLE:
        if start <= hour < end:
            return multiplier
    return DEFAULT_RUSH_HOUR_MULTIPLIER


def naive_baseline_predict(df: pd.DataFrame) -> np.ndarray:
    """The dumbest baseline: straight-line distance / a constant average speed, with no
    adjustment at all. Phase 8's simulator already computed and stored this exact figure per
    trip (`naive_duration_seconds`) — reused directly rather than recomputed, so there's no risk
    of it silently diverging from what's actually in the dataset."""
    return df["naive_duration_seconds"].to_numpy(dtype=float)


def heuristic_baseline_predict(df: pd.DataFrame) -> np.ndarray:
    """Reproduces the live Phase 7 `/trips/:id/eta` heuristic (docs/eta.md): naive duration *
    rush-hour multiplier, using the *integer* local hour — matching eta-heuristic.ts's
    getHours()-based table lookup exactly, not the fractional hour used for the model's own
    cyclical features (app/ml/features.py). This baseline has no awareness of zone density —
    that's the gap the trained model has room to close (see docs/eta-model.md)."""
    requested_at = pd.to_datetime(df["requested_at"], utc=True)
    local_hour = requested_at.dt.tz_convert(SIMULATION_TIME_ZONE).dt.hour
    multipliers = local_hour.apply(rush_hour_multiplier).to_numpy(dtype=float)
    return naive_baseline_predict(df) * multipliers

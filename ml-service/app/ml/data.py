"""Loads Phase 8's simulated training data directly from Postgres — a direct DB connection was
chosen over an exported CSV/parquet snapshot because the data already lives in Postgres
(core/scripts/simulate-historical-trips.ts writes straight to `training_trips`) and ml-service
already has DATABASE_URL wired up to the same database (infra/docker-compose.yml). An export step
would just be a second copy that goes stale the moment the simulator re-runs, for no benefit in a
single-database setup like this one. See docs/eta-model.md.

Deliberately selects only the columns a real trip request could ever provide, plus the two
duration figures needed for training/baseline comparison — NOT
time_of_day_multiplier/zone_density_factor/noise_factor (see app/ml/features.py's module
docstring for why those would leak the target's construction mechanism).
"""

import pandas as pd
from sqlalchemy import create_engine

from app.config import settings

TRAINING_QUERY = """
    SELECT
        ST_Y(pickup_location::geometry)  AS pickup_lat,
        ST_X(pickup_location::geometry)  AS pickup_lng,
        ST_Y(dropoff_location::geometry) AS dropoff_lat,
        ST_X(dropoff_location::geometry) AS dropoff_lng,
        requested_at,
        naive_duration_seconds,
        actual_duration_seconds
    FROM training_trips
    ORDER BY requested_at ASC
"""


def load_training_data() -> pd.DataFrame:
    engine = create_engine(settings.database_url)
    try:
        df = pd.read_sql(TRAINING_QUERY, engine)
    finally:
        engine.dispose()

    # Postgres timestamptz round-trips as tz-aware via psycopg2, but normalize explicitly to UTC
    # regardless of driver/session quirks — every downstream consumer (features, baselines,
    # split) assumes a tz-aware UTC column.
    df["requested_at"] = pd.to_datetime(df["requested_at"], utc=True)
    return df

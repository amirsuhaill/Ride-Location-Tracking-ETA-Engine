"""Constants deliberately mirrored from the core (TypeScript) service, so the ETA model's feature
engineering and baseline predictors agree with the rest of this project's assumptions. Python and
TypeScript can't literally share one source file across this repo, so if any of the referenced
core file changes, this module needs a matching update — that's a real, accepted maintenance cost
of the two-language split, not an oversight.
"""

from zoneinfo import ZoneInfo

# Mean Earth radius in meters — mirrors core/src/services/haversine.ts (also PostGIS's `geography`
# type's own spherical model, see docs/schema.md).
EARTH_RADIUS_METERS = 6_371_000

# All trip timestamps are generated/interpreted in this zone — mirrors core's TZ env var
# (core/.env, docs/eta.md) and core/scripts/lib/trip-simulator.ts's local-time construction
# (docs/historical-data-simulator.md). Every place this model reads an hour-of-day or
# day-of-week from a timestamp must convert to this zone first, or it'll reproduce the exact
# Pacific/UTC bucketing bug documented in docs/historical-data-simulator.md.
SIMULATION_TIME_ZONE = ZoneInfo("America/Los_Angeles")

# "Downtown" reference point for the zone-density proxy — mirrors CITY_CENTER in
# core/scripts/lib/trip-simulator.ts (Union Square / Financial District-ish).
CITY_CENTER = {"lat": 37.7749, "lng": -122.4194}

# Baseline average speed for both baseline predictors below — mirrors ETA_AVG_SPEED_MPS's default
# (core/.env.example, docs/eta.md).
AVG_SPEED_METERS_PER_SECOND = 8.0

# Rush-hour windows/multipliers — mirrors RUSH_HOUR_TABLE in core/src/services/eta-heuristic.ts
# exactly (start-inclusive, end-exclusive hour windows). Used only by the "heuristic" baseline
# below (reproducing the live Phase 7 ETA endpoint's behavior for comparison) — the model itself
# does not use this table; it learns its own rush-hour-like pattern from the cyclical hour
# features instead.
RUSH_HOUR_TABLE = [
    (7, 9, 1.4),  # morning commute
    (16, 19, 1.5),  # evening commute
]
DEFAULT_RUSH_HOUR_MULTIPLIER = 1.0

# ML ETA Model (Phase 9)

A trained regression model that replaces (well — is compared against and beats) Phase 7's
haversine + rush-hour heuristic, using Phase 8's simulated historical trip data. Lives in
`/ml-service`: `scripts/train_model.py` (standalone retraining) + `app/ml/` (feature engineering,
baselines, model persistence, all shared with serving) + `POST /predict-eta` (FastAPI).

## Loading the data: direct DB connection, not a CSV/parquet export

`app/ml/data.py` connects straight to the same Postgres database core uses
(`DATABASE_URL`, already wired up in `infra/docker-compose.yml` — nothing new to configure).
Rejected an export-to-CSV/parquet step: the data already lives in Postgres
(`core/scripts/simulate-historical-trips.ts` writes straight to `training_trips`,
`docs/historical-data-simulator.md`), and in a single-database setup like this one, an exported
snapshot would just be a second copy that goes stale the moment the simulator re-runs — there's
no multi-team/cross-system boundary here that would justify the extra export/sync step.

## Feature engineering

`app/ml/features.py#build_features` — used identically by **both** training
(`scripts/train_model.py`) and serving (`app/main.py`'s `/predict-eta`), on purpose: a common,
real ML bug is subtly different feature computation between training and inference ("train/serve
skew"). There is exactly one feature-engineering code path in this codebase.

| Feature | What | Why this shape |
| --- | --- | --- |
| `haversine_distance_m` | Straight-line pickup→dropoff distance | Same formula/Earth-radius constant as `core/src/services/haversine.ts` — the single strongest predictor of duration, confirmed below. |
| `hour_sin`, `hour_cos` | Cyclical encoding of local (Pacific) fractional hour-of-day | A raw integer hour feature would make 23:59 and 00:01 look maximally far apart to the model, when they're a minute apart. `sin`/`cos` of `2π × hour/24` fixes that — see `test_cyclical_hour_encoding_treats_2359_and_0001_as_nearly_identical`. Uses a *fractional* hour (`hour + minute/60 + second/3600`) for a smooth cycle, unlike the baseline heuristic's integer-hour table lookup (see below) — the model doesn't need to reproduce that coarser bucketing. |
| `dow_sin`, `dow_cos` | Cyclical encoding of local day-of-week | Included because the prompt asks for day-of-week as a feature. Phase 8's simulator does **not** inject differentiated day-of-week demand (documented there as a scope simplification) — so, honestly, expect this model to assign it near-zero importance on this dataset. It's computed correctly and ready for real data (where day-of-week very much matters) regardless. |
| `midpoint_distance_from_center_km` | Distance from a fixed "downtown" point to the pickup/dropoff midpoint | The traffic/density proxy. **Derived from raw pickup/dropoff coordinates only** — not read from `training_trips.zone_density_factor`. |

### Why not just use the stored `zone_density_factor` column?

`training_trips` has `time_of_day_multiplier`, `zone_density_factor`, and `noise_factor` columns
— the exact factors Phase 8's simulator multiplied together to build `actual_duration_seconds`
(`docs/historical-data-simulator.md`). None of them are used as model inputs here, deliberately.
A real trip request will never come with a `zone_density_factor` attached — that column only
exists because we know how this *synthetic* dataset's target was constructed. Using it as a
feature would let the model trivially "solve" this dataset by re-deriving the exact generating
formula, which (a) doesn't test whether it can learn the *pattern* from realistic inputs, and (b)
would produce a model that immediately breaks on real data, which never has this column. Every
feature actually used here — pickup, dropoff, timestamp — is something a real trip request
genuinely provides.

## Model: RandomForestRegressor, not linear regression

`scripts/train_model.py` — scikit-learn's `RandomForestRegressor` (200 trees, `max_depth=12`,
`min_samples_leaf=5`, `random_state=42` for reproducible bootstrap/feature sampling — the
train/test split itself is chronological, not random, so there's nothing else here to seed).

**Why not linear regression**: the two dominant effects in this data are both non-linear/
threshold-shaped. Rush hour is a step function of hour-of-day (flat, then +40-50%, then flat
again) — a linear model would need hand-built indicator/interaction terms to capture that shape
at all, and would still apply the same slope everywhere. The zone-density proxy is an exponential
decay from the city center (`docs/historical-data-simulator.md`) — again not a straight line.
Tree-based models capture both automatically via splits, with no manual feature-shape engineering
required, which is exactly why "start with something interpretable like gradient boosting or
random forest" beats linear regression here. `feature_importances_` still gives a
plain-language explanation of what the model is actually using (see the real run below) — that's
the "interpretable" part.

## Train/test split: chronological, not random

`app/ml/split.py#time_based_split` sorts by `requested_at` and holds out the chronologically
*last* 20% as the test set — not a random 80/20 shuffle.

**Why this is more honest for this data**: this is time-series-flavored data. A random split
would let rows from the same time period sit in both train and test, letting the model
implicitly benefit from patterns specific to that period showing up on "both sides" of the
split — silently overstating how well it'd do on genuinely future, unseen trips. Holding out the
chronologically last slice simulates the actual deployment scenario: train on the past, evaluate
on data that came strictly after it, the same test a freshly-deployed model would actually face.
This particular synthetic dataset has no explicit time-drift injected (Phase 8's demand curve and
rush-hour table don't change over the 30 simulated days), so a random split wouldn't have leaked
anything *today* — but establishing this discipline now, before real (genuinely drifting) trip
data exists, is the whole point.

**Verified the split doesn't leak, not just asserted**: `scripts/train_model.py` runs
`assert train_df["requested_at"].max() <= test_df["requested_at"].min()` right after splitting,
and `test/test_split.py` has a dedicated test for exactly this property on synthetic data.

## Baselines — why a bare MAE means nothing

`app/ml/baselines.py`:

- **`naive_baseline`**: straight-line distance / constant average speed, no adjustment at all —
  reuses `training_trips.naive_duration_seconds` directly (Phase 8 already computed this exact
  figure; recomputing it here would just risk it silently diverging).
- **`heuristic_baseline`**: reproduces the live Phase 7 `/trips/:id/eta` heuristic exactly
  (`docs/eta.md`) — naive duration × the same `RUSH_HOUR_TABLE` multiplier, using the *integer*
  local hour (matching `eta-heuristic.ts`'s `getHours()`-based lookup, not the model's fractional-
  hour features). This baseline has zero awareness of zone density — that's the gap the trained
  model has room to close.

## Real results (captured from an actual training run)

```
Loading training data from training_trips...
Loaded 5000 rows, date range 2025-12-03 08:35:15+00:00 .. 2026-01-02 07:51:39+00:00
Train: 4000 rows (2025-12-03 08:35:15+00:00 .. 2025-12-27 12:17:31+00:00)
Test:  1000 rows (2025-12-27 13:01:36+00:00 .. 2026-01-02 07:51:39+00:00) — chronologically after every train row

=== Evaluation on held-out test set (chronologically last 20%) ===
predictor                MAE (s)    RMSE (s)
naive_baseline             532.0       674.8
heuristic_baseline         421.6       513.6
random_forest              123.1       173.0

Random forest vs naive baseline:     +76.9% MAE
Random forest vs heuristic baseline: +70.8% MAE

Feature importances:
  haversine_distance_m                0.815
  hour_sin                            0.105
  hour_cos                            0.044
  midpoint_distance_from_center_km    0.033
  dow_sin                             0.002
  dow_cos                             0.001

Saved model to /app/models/eta_model_20260804T062150341857Z.joblib
```

Confirms the design intent throughout: the random forest beats the naive baseline by **76.9%**
MAE and the smarter rush-hour-aware heuristic by **70.8%** MAE — because it also picks up the
zone-density signal neither baseline has access to (`midpoint_distance_from_center_km` at 0.033
importance, non-trivial). Distance dominates (0.815, expected — it's the base of every duration
calculation in this dataset), the hour features pick up the rush-hour pattern the heuristic uses,
and day-of-week lands at ~0 importance — exactly as predicted above, since Phase 8 never injected
a day-of-week signal to find.

**Reproducibility check, run twice for real**: re-running `python scripts/train_model.py`
against the same data produced the identical MAE/RMSE table above (`123.1` / `173.0` for the
random forest) — `random_state=42` makes the forest's own internal randomness reproducible run to
run, given the same (deterministic, chronological) split and the same input data.

## Model persistence and versioning

`app/ml/model_store.py`: every training run writes a **new**, never-overwritten
`models/eta_model_<UTC-timestamp-to-the-microsecond>.joblib`, plus updates `models/latest.json` —
a small pointer file recording which filename is current, `trained_at`, the feature list, full
metrics (including the baseline comparison and feature importances above), and the training/test
row counts and date range. Verified live: running the script twice back-to-back produced two
distinct `.joblib` files, both still present on disk, with `latest.json` pointing at the newer
one (`test/test_model_store.py` covers this with a fabricated model too).

`ml-service/models/` is gitignored (fully regenerable build output) and, in Docker, is a named
volume (`ml_models` in `infra/docker-compose.yml`) mounted at `/app/models` — so a container
rebuild/recreate never silently wipes out a trained model, the same reasoning as `postgres_data`.

## Serving: `POST /predict-eta`

Request:

```json
{
  "pickup": { "lat": 37.7749, "lng": -122.4194 },
  "dropoff": { "lat": 37.8044, "lng": -122.2712 },
  "timestamp": "2026-01-15T16:00:00Z"
}
```

Response `200`:

```json
{
  "predicted_duration_seconds": 3074.17,
  "distance_meters": 13429.63,
  "model_version": "20260804T062150341857Z"
}
```

A naive (no UTC offset) `timestamp` is treated as UTC before feature-building, consistent with how
Postgres stores `timestamptz` and how `app/ml/data.py` normalizes training data.

**Validation — Pydantic v2, no custom code needed** (`app/ml/schemas.py`): `lat`
(-90..90), `lng` (-180..180) via `Field(ge=..., le=...)`, and `timestamp` as a real `datetime`
field — FastAPI's default handler turns any violation into a `422` with a structured `detail`
array, never a crash or a fabricated prediction. Verified against the **real running service**,
not just mocked tests:

```
$ curl -X POST http://localhost:8000/predict-eta -d '{"pickup":{"lat":200,...}, ...}'
HTTP 422
{"detail":[{"type":"less_than_equal","loc":["body","pickup","lat"],"msg":"Input should be less than or equal to 90", ...}]}

$ curl -X POST http://localhost:8000/predict-eta -d '{..., "timestamp":"not-a-timestamp"}'
HTTP 422
{"detail":[{"type":"datetime_from_date_parsing", ...}]}

$ curl -X POST http://localhost:8000/predict-eta -d '{"pickup":{...}, "timestamp":"..."}'  # dropoff missing
HTTP 422
{"detail":[{"type":"missing","loc":["body","dropoff"],"msg":"Field required", ...}]}
```

The server process itself never crashed across any of these (or a malformed-JSON body, or an
out-of-range `lng`) — confirmed by checking `/health` still responded after every one.

### Loaded once at startup, not retrained per request

`app/main.py` calls `load_latest_model()` once, at import time (process startup) — `/predict-eta`
just calls `.predict()` on whatever was loaded then. If `scripts/train_model.py` has never been
run, both are `None` and the endpoint returns a clear `503` (verified against the real,
freshly-built container, with an empty `ml_models` volume, before training ever ran):

```
$ curl http://localhost:8000/health
{"status":"ok", ..., "eta_model_loaded": false, "eta_model_version": null}
$ curl -X POST http://localhost:8000/predict-eta -d '{...}'
HTTP 503
{"detail":"No ETA model has been trained yet — run scripts/train_model.py first."}
```

**Picking up a freshly retrained model requires restarting the process** — there's no hot-reload
endpoint. This is a deliberate simplicity choice (matches how this project's other config is
loaded once at startup, e.g. `core/src/config.ts`), not an oversight; verified live: right after
training completed inside the running container, `/health` still reported
`eta_model_loaded: false` until `docker compose restart ml-service`, after which it picked up the
new model and `/predict-eta` started returning real predictions.

## Retraining

```
cd ml-service
python scripts/train_model.py                              # defaults
python scripts/train_model.py --n-estimators 300 --max-depth 15 --test-size 0.25
```

or, against the Docker stack:

```
docker compose -f infra/docker-compose.yml exec ml-service python scripts/train_model.py
docker compose -f infra/docker-compose.yml restart ml-service   # to serve the new model
```

No code changes needed — every run reads whatever is currently in `training_trips` (re-run
`npm run simulate:trips` in `core/` first to refresh/grow the dataset) and produces a new
versioned artifact, never overwriting a prior one.

## Verifying it yourself

```
cd ml-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
ruff check .                # lint
python -m pytest tests/ -v  # 28 tests: features, baselines, split, model_store, /predict-eta
python scripts/train_model.py
uvicorn app.main:app --reload   # then curl /predict-eta as shown above
```

- `tests/test_features.py` — haversine correctness against known airport-pair distances,
  cyclical-encoding boundedness and the midnight/noon and 23:59-vs-00:01 properties above,
  `build_features`'s exact output columns, and that it works with an input frame that has none of
  the ground-truth-construction columns at all.
- `tests/test_baselines.py` — the rush-hour table lookup matches `core`'s exactly (including
  boundary inclusivity), and the heuristic baseline's multiplier math.
- `tests/test_split.py` — proportions, the no-leak chronological guarantee, determinism, and
  rejecting an invalid `test_size`.
- `tests/test_model_store.py` — save/load round-trips a real (dummy) fitted model and its
  metadata, `(None, None)` before any training run, and two consecutive saves produce two
  distinct files with `latest.json` tracking the newer one.
- `tests/test_predict_eta.py` — FastAPI `TestClient` against the real app (a fitted
  `DummyRegressor` injected via `monkeypatch` isolates endpoint plumbing from model quality,
  which the training script's own evaluation output already covers): the happy path, a naive
  (no-offset) timestamp, four different out-of-range-coordinate shapes, a malformed timestamp
  string, a missing required field, and the pre-training `503`.

Beyond the pytest suite (mocked model for endpoint tests, by design), this phase was verified live
end-to-end: built the real Docker image, trained against the actual `training_trips` data over a
live Postgres connection, confirmed the pre-training `503`, confirmed the model requires a
restart to be picked up (not silently hot-reloaded), and hit `/predict-eta` over real HTTP with
both valid and invalid payloads — all captured above, not hypothetical.

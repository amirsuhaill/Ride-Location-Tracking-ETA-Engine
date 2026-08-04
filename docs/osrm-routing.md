# Route-Based ETA via OSRM (Phase 15)

Replaces straight-line/haversine distance with **real road-network distance and duration** from a
real, self-hosted [OSRM](http://project-osrm.org/) instance — for core's live heuristic ETA path,
and as an evaluated (but not served) extra feature for ml-service's Phase 9 model.

## Standing up OSRM with real map data

`infra/scripts/prepare-osrm-data.sh` fetches a **targeted, road-only** OpenStreetMap extract for
this project's exact SF bounding box (the same one used throughout `core/scripts/seed.ts` and the
Phase 8 trip simulator) via the Overpass API (`way[highway]` + referenced nodes only), rather than
downloading a full regional `.osm.pbf` (hundreds of MB) — deliberate scope: OSRM's car profile
only needs the road graph, and a bbox-scoped fetch finishes in well under a minute. It then runs
OSRM's standard preprocessing pipeline via `osrm/osrm-backend`'s own Docker image:

```
osrm-extract -p /opt/car.lua sf.osm      # ~134MB peak RAM, real captured run
osrm-contract sf.osrm                    # Contraction Hierarchies, ~80MB peak RAM
```

Contraction Hierarchies (`--algorithm ch`) was chosen over the newer MLD pipeline
(`osrm-partition` + `osrm-customize`) for simplicity — this extract is small enough that CH's
longer preprocessing time and larger on-disk footprint aren't a real cost, and CH is the
long-established, simpler-to-reason-about option. Real captured run: **~95 seconds total**
(extract + contract) for the full SF road network. Output (`infra/osrm-data/`, gitignored,
regenerable — see the script) is served via `osrm-routed --algorithm ch`.

### `infra/docker-compose.yml`'s `osrm` service

```yaml
osrm:
  image: osrm/osrm-backend
  command: osrm-routed --algorithm ch /data/sf.osrm
  volumes:
    - ./osrm-data:/data:ro
  ports:
    - "${OSRM_PORT:-5001}:5000"
  healthcheck:
    test: ["CMD", "bash", "-c", "echo > /dev/tcp/127.0.0.1/5000"]
    ...
```

Two machine-specific quirks worth documenting:

- **Host port 5000 collision on macOS**: `osrm-routed` listens on 5000 internally, but modern
  macOS's AirPlay Receiver/ControlCenter already binds host port 5000 by default — `docker run -p
  5000:5000 ...` fails with `address already in use`. The default host mapping is **5001**
  instead (`OSRM_PORT`), confirmed working immediately once remapped.
- **No `curl`/`wget` in the image**: `osrm/osrm-backend` is a minimal Debian 9 (stretch) image —
  confirmed via `docker run --rm osrm/osrm-backend sh -c "cat /etc/os-release"` — with neither
  HTTP client tool installed, so the usual `curl -f http://localhost:PORT/health`-style healthcheck
  (used by core/ml-service's own Dockerfiles) doesn't work here. `bash` **is** present
  (`/bin/bash`, confirmed), so the healthcheck uses bash's `/dev/tcp` pseudo-device for a real TCP
  connect check instead — verified directly against a running container before writing it into
  compose (`docker exec ... bash -c "echo > /dev/tcp/127.0.0.1/5000"` succeeded against a live
  `osrm-routed` process). `core` and `ml-service` deliberately do **not** `depends_on: osrm` with a
  health condition — OSRM being down is a fully-handled, tested case (see below), not something
  that should block either service from starting, the same design principle already established
  for ml-service in Phase 10 (`docs/eta-integration.md`).

## The real, verified OSRM HTTP contract (a genuine surprise, corrected before writing any client)

The initial assumption — that OSRM would follow ml-service's own convention (HTTP 200 with an
in-body error code) — was wrong, and was caught by direct verification before any client code was
written:

```
$ curl -sS "http://localhost:5001/route/v1/driving/-122.4194,37.7749;-122.4083,37.7879?overview=false"
{"code":"Ok","routes":[{"legs":[...],"distance":2552.4,"duration":368.5,...}],"waypoints":[...]}

$ curl -sS -o /tmp/out.json -w "HTTP %{http_code}\n" \
    "http://localhost:5001/route/v1/driving/-122.4194,37.7749;-122.4083,37.7879?overview=false&radiuses=1;1"
HTTP 400
$ cat /tmp/out.json
{"message":"Could not find a matching segment for coordinate 0","code":"NoSegment"}
```

A routing failure (`NoRoute`/`NoSegment`) is **HTTP 400**, not 200 — genuinely different from
ml-service's own `/predict-eta` (which always responds 200 and signals problems, if any, via a
different mechanism). Both `core/src/services/osrm-client.ts` and
`ml-service/app/ml/osrm_client.py` account for this explicitly: the response body is **always**
parsed as JSON first, regardless of HTTP status, and a recognizable non-`"Ok"` `code` field is
treated as `"no_route"` *before* falling back to status/shape-based classification for genuinely
malformed or unexpected responses.

**Also worth noting**: OSRM's default point-snapping radius is generous — a point that seems "in
the water" often still snaps to the nearest real road several kilometers away and returns a valid
(if long) route, rather than failing. The reliable way to force `NoSegment` (used above and in
every "no route" test) is the `radiuses` query parameter (e.g. `&radiuses=1;1` — a 1-meter
tolerance nowhere near a mapped road).

## core: the OSRM client and its fallback (Phase-10-style)

`core/src/services/osrm-client.ts#fetchOsrmRoute` mirrors `ml-eta-client.ts#fetchMlEta`'s design
exactly — a discriminated result instead of throwing — with the HTTP-400 correction above:

| Failure | How it's produced | How it's detected |
| --- | --- | --- |
| **Unreachable** | `fetch()` throws something other than an `AbortError`. | `reason: "unreachable"` |
| **Timeout** | `AbortController` aborts after `ETA_OSRM_TIMEOUT_MS` (default **300ms**). | `reason: "timeout"` |
| **No route** | Body parses as JSON with a `code` that isn't `"Ok"` (any HTTP status). | `reason: "no_route"` |
| **Error status** | Non-2xx status with no recognizable `code`. | `reason: "error_status"` |
| **Malformed response** | 200/`code: "Ok"` but body doesn't have the expected `routes[0].distance`/`.duration` shape. | `reason: "malformed_response"` |

`eta.service.ts`'s heuristic computation (`computeHeuristicEta`) tries OSRM first when
`ETA_OSRM_ENABLED=true`, tagging a successful result `"heuristic_osrm"` (a new `EtaSource` value);
any failure logs a warning and falls straight back to the existing haversine `estimateEta`, tagged
plain `"heuristic"` — indistinguishable, from the outside, from OSRM being disabled entirely. This
same fallback path is shared by `"ml_with_fallback"` mode's own fallback branch (still tagged
`ml_fallback`, per the existing `EtaSource` contract — enabling OSRM improves *every* path that
ultimately falls back to the heuristic, not just plain `mode: "heuristic"`). OSRM's own duration is
a free-flow estimate with no traffic model of its own, so the same rush-hour multiplier used by
the haversine heuristic is layered on top of it, exactly as it would be for a plain haversine
estimate.

`ETA_OSRM_ENABLED` defaults to **`false`** — a fresh checkout without a built OSRM dataset
(`infra/scripts/prepare-osrm-data.sh` hasn't been run) degrades to the exact pre-Phase-15 behavior
instead of every heuristic ETA call failing or timing out against a nonexistent service.

### Tested against a real local HTTP server, not a mocked `fetch`

`core/test/helpers/osrm-stub-server.ts` (mirrors `ml-stub-server.ts`) spins up a genuine
`node:http` server per test, with handlers for every scenario including the real `NoSegment`/HTTP
400 no-route shape. `core/test/eta-osrm-fallback.test.ts` — 8 tests: real success, all 5 failure
modes (unreachable, timeout, malformed, error status, **no route**), the `ETA_OSRM_ENABLED=false`
no-op case, and the `ml_with_fallback`-uses-OSRM-too case.

```
$ npm test
...
✓ test/eta-osrm-fallback.test.ts (8 tests)
Test Files  25 passed (25)
     Tests  194 passed (194)
```

### Verified live, against the real Docker containers (not just the stub tests)

Brought up `postgres`, `redis`, `osrm`, and `core` (with `ETA_OSRM_ENABLED=true`,
`ETA_MODE=heuristic`) via `docker compose up -d`, created a real driver/rider/trip, and hit the
real endpoint:

```
$ curl -i http://localhost:3000/trips/<id>/eta
X-ETA-Source: heuristic_osrm
X-ETA-Cache: miss
{"status":"ok","etaSeconds":155.2,"distanceMeters":1178.3,"etaSource":"heuristic_osrm", ...}

# docker compose stop osrm, move the driver (forces a fresh recompute attempt):
X-ETA-Source: heuristic
{"status":"ok","etaSeconds":27.04,"distanceMeters":216.32,"etaSource":"heuristic", ...}
# fell back to haversine — no crash, no hang

# docker compose start osrm, wait for healthy, move the driver again:
X-ETA-Source: heuristic_osrm
{"status":"ok","etaSeconds":135.8,"distanceMeters":902.4,"etaSource":"heuristic_osrm", ...}
# recovered automatically on the very next recompute, no restart of core needed
```

All containers torn down (`docker compose down`) after this check.

## ml-service: OSRM as a comparison feature, not a served one

`ml-service/app/ml/osrm_client.py#fetch_osrm_route` is the Python equivalent of the core client
(same discriminated result, same corrected HTTP-400 parsing order), used only by
`scripts/train_model.py` — **not** wired into live `/predict-eta` serving. This is a deliberate
scope decision, the same "standalone, fully-tested, not wired into the production path" precedent
already established for the sharding/geohash modules on the core side (see `docs/sharding.md`'s
scope note): `/predict-eta`'s live feature pipeline (`app/ml/features.py`) has no OSRM feature, so
training a model that *requires* one and then serving it anyway would silently misalign every
prediction's feature vector.

### How the comparison stays fair

1. `train_model.py` does the **exact same chronological split** (`time_based_split`, Phase 9's
   `time_based_split` unmodified) it always did, on the full un-filtered dataset — the production
   model (saved via `save_model`, unaffected by anything below) is trained and evaluated exactly
   as Phase 9 specified.
2. OSRM's real duration is then computed for every train/test row (in parallel, 8 concurrent
   requests against the local OSRM container). Rows OSRM genuinely can't route are dropped
   (logged, count + percentage) — from *within* the existing split, never by re-splitting, so the
   comparison model's test rows are the same rows the production model was just evaluated on,
   minus only the handful (or zero) that couldn't be routed at all.
3. A second RandomForestRegressor — identical hyperparameters and `random_state=42` — is trained
   with `osrm_duration_seconds` added to the feature set, and evaluated on the identical resulting
   test rows. The production model's own predictions are also re-evaluated on that identical
   subset, so both sides of the delta are computed from the same rows.
4. If OSRM is completely unreachable, every row would show as "no route" — treated as a service
   outage, not a modeling result: the script logs a clear warning, skips the comparison, and still
   saves the production model (which never depended on OSRM at all).

### Real captured run (5000 rows, seed 42, Phase 8's `training_trips`)

```
$ docker compose exec ml-service python scripts/train_model.py

Loaded 5000 rows, date range 2025-12-03 08:35:15+00:00 .. 2026-01-02 07:51:39+00:00
Train: 4000 rows / Test: 1000 rows (chronologically after every train row)

=== Evaluation on held-out test set (chronologically last 20%) ===
predictor                MAE (s)    RMSE (s)
naive_baseline             532.0       674.8
heuristic_baseline         421.6       513.6
random_forest              123.1       173.0

Querying OSRM (http://osrm:5000) for each trip's real road-network duration...
OSRM routed 3999/4000 train rows (1 no-route, 0.0%) and 1000/1000 test rows (0 no-route, 0.0%)

=== OSRM feature comparison — identical 1000-row held-out test set ===
model                        MAE (s)    RMSE (s)
without_osrm_feature           123.1       173.0
with_osrm_feature              123.5       173.6

With OSRM feature vs without: -0.3% MAE, -0.3% RMSE

Saved model to /app/models/eta_model_20260804T182600384652Z.joblib
```

**Honest reading of this result — the OSRM feature made things very slightly *worse*, not
better.** This is a real, unfabricated outcome, and it makes sense given how this project's
training data is constructed: Phase 8's simulator derives `actual_duration_seconds` from
**haversine distance** plus synthetic time-of-day/zone-density/noise factors
(`core/scripts/lib/trip-simulator.ts`) — it has no real-world road curvature or map-matched
driving time baked into it at all. OSRM's real road-network duration is *more realistic* than
haversine, but that realism doesn't correlate with a synthetic ground truth that was never derived
from real road geometry in the first place — so the extra feature is redundant with (and adds a
small amount of noise on top of) what `haversine_distance_m` already captures, rather than adding
genuine new signal. Feature importances from the same run confirm this reading:
`haversine_distance_m` alone already accounts for **81.5%** of the without-OSRM model's importance
— there's very little unexplained variance left for OSRM's duration to usefully claim. Coverage
was effectively total (`1/5000` trips, 0.02%, had no route at all), so the comparison itself is not
an artifact of a small or lossy dataset — this SF road-network extract fully covers the project's
simulated bbox.

This is exactly the kind of result the phase's acceptance criteria (report the delta "so the
improvement, or lack thereof, is a fair comparison") anticipates as a legitimate outcome: a real
feature can genuinely not help, and the honest thing to do is say so, not force a narrative.
`/predict-eta` continues serving the unaffected, unmodified production model — confirmed via a
real post-retrain request:

```
$ curl -X POST http://localhost:8000/predict-eta -d '{"pickup":{...},"dropoff":{...},"timestamp":"..."}'
{"predicted_duration_seconds":3074.17,"distance_meters":13429.63,"model_version":"20260804T182600384652Z"}
```

### Tests

`ml-service/tests/test_osrm_client.py` — 7 tests against a real local `http.server` (a genuine
socket, not a mocked `httpx` transport): real success, both no-route codes (`NoSegment`/`NoRoute`,
HTTP 400), unreachable, timeout (with an elapsed-time assertion proving a genuine abort, not an
eventually-successful wait), non-routing error status, and a malformed response body.

```
$ pytest
...
tests/test_osrm_client.py ....... (7 passed)
======================== 35 passed in 7.55s ========================
```

## Configuration

| Var | Default | Meaning |
| --- | --- | --- |
| `OSRM_PORT` (infra) | `5001` | Host port mapped to `osrm-routed`'s internal 5000 — not 5000 itself, due to the macOS AirPlay collision above. |
| `OSRM_URL` (core, ml-service) | `""` (core), `""` (ml-service) | Base URL of the OSRM service, e.g. `http://osrm:5000` inside Docker. |
| `ETA_OSRM_ENABLED` (core) | `false` | Whether the heuristic ETA path attempts OSRM before falling back to haversine. |
| `ETA_OSRM_TIMEOUT_MS` (core) | `300` | Max wait for OSRM before treating it as a failure (live-serving path — short, matches `ETA_ML_TIMEOUT_MS`'s reasoning). |
| `OSRM_TIMEOUT_SECONDS` (ml-service) | `2.0` | Max wait per OSRM call during retraining — generous, since this is a batch script, not a latency-sensitive request path. |

## Verifying it yourself

```
cd core && npm test            # includes eta-osrm-fallback.test.ts (8 tests)
cd ml-service && pytest        # includes test_osrm_client.py (7 tests)

bash infra/scripts/prepare-osrm-data.sh   # regenerate infra/osrm-data/ (gitignored)
docker compose -f infra/docker-compose.yml up -d osrm
curl "http://localhost:5001/route/v1/driving/-122.4194,37.7749;-122.4083,37.7879?overview=false"
docker compose -f infra/docker-compose.yml exec ml-service python scripts/train_model.py
```

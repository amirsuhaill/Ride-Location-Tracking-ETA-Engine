# Baseline Heuristic ETA (Phase 7)

A haversine-distance + configurable-average-speed + table-driven-rush-hour-multiplier estimate.
`GET /trips/:id/eta` exposes it; recomputation is triggered by driver location updates but
throttled so it doesn't run on every single tick.

**As of Phase 10**, this heuristic is one of three selectable engines (`ETA_MODE=heuristic`, the
default) — it's also the fallback used when `ETA_MODE=ml_with_fallback` and ml-service fails, and
everything on this page (the formula, the rush-hour table, the throttle mechanism) is exactly what
runs in both of those cases too. See `docs/eta-integration.md` for the ML integration, the mode
toggle, the new `ml_unavailable` status, and the `etaSource`/`servedFromCache` response fields.

## Haversine distance

`src/services/haversine.ts` — the standard great-circle formula, using a mean Earth radius of
6,371,000m (the same spherical model PostGIS's `geography` type uses — see `docs/schema.md`'s
geography-vs-geometry rationale — so distances stay consistent with the rest of the project).

**Validated against known real-world distances** (`test/eta-haversine.test.ts`), not just
internal consistency:

| Pair | Commonly cited great-circle distance | Our computed value | Diff |
| --- | ---: | ---: | ---: |
| JFK ↔ LAX | ~3,983 km (2,475 mi) | ~3,974 km | ~0.2% |
| SFO ↔ LAX | ~543 km (337 mi) | ~543.7 km | ~0.1% |

Tests assert within **1%** tolerance. The ~0.1-0.2% gap is expected, not a bug: the commonly
cited figures are usually computed on an ellipsoidal/geodesic (WGS84) model, while this is a
spherical mean-radius model — the two are known to diverge slightly, more so at longer distances
and higher latitudes. 1% is generous enough to not be sensitive to that known, understood gap
while still being tight enough to catch a real formula error (e.g. a sign flip or a degrees/
radians mixup would be off by far more than 1%). A same-point check (0m) and an independent
check against "1° of latitude ≈ 111,194.9m for a 6,371km-radius sphere" (a textbook identity, not
derived from our own code) round out the coverage.

## ETA estimate: distance / speed, adjusted for rush hour

`src/services/eta-heuristic.ts#estimateEta`:

```
baseEtaSeconds = haversineDistanceMeters(from, to) / avgSpeedMetersPerSecond
etaSeconds     = baseEtaSeconds * rushHourMultiplier(now)
```

`avgSpeedMetersPerSecond` is `ETA_AVG_SPEED_MPS` (default **8 m/s ≈ 18 mph ≈ 29 km/h**) — a
placeholder "typical urban arterial average including signals/stops" figure, explicitly *not*
calibrated to this project's own data (there is none yet — no live GPS/traffic feed). Documented
here as exactly that: a reasonable starting assumption to replace once real trip duration data
exists (Phase 8/9).

### Rush-hour multiplier table

**Table-driven, not hardcoded conditionals** — `RUSH_HOUR_TABLE` in `eta-heuristic.ts` is a named,
documented array of `{startHour, endHour, multiplier}` windows that `getRushHourMultiplier` just
iterates over, rather than an `if (hour >= 7 && hour <= 9) ...` scattered inline. It's a plain TS
constant rather than a flat env var deliberately: a list of time windows has no natural flat
env-var shape, and a single named, version-controlled source of truth is more maintainable here
than a fragile serialized-JSON env var for this particular shape of data. (The scalar knobs —
average speed, recompute thresholds, staleness threshold — *are* plain env vars, consistent with
the rest of this project's config.)

| Window | Multiplier | 
| --- | --- |
| 7:00–9:00 | **1.4×** (morning commute) |
| 16:00–19:00 | **1.5×** (evening commute) |
| Everything else | 1.0× (no adjustment) |

**Source/reasoning — these are placeholder estimates**, not calibrated to any real traffic data
for this project. Loosely based on commonly-cited US urban commute congestion research (e.g.
INRIX / Texas A&M Transportation Institute-style findings that peak-hour congestion typically
adds roughly 30-60% to free-flow travel time in major metro areas). The evening window is wider
and slightly higher than the morning one because evening commutes typically spread over a
longer, marginally worse window than the more concentrated morning commute. Replace with real
measured multipliers once trip duration data exists (Phase 8+) — this table is explicitly a
starting heuristic, not a claim of accuracy.

**Known limitation — server-local time, not per-trip time zone**: `getRushHourMultiplier`
evaluates `Date.prototype.getHours()` in the server process's local time zone. For this
project's single-city (San Francisco) scope, `TZ=America/Los_Angeles` is set explicitly
(`infra/docker-compose.yml`, `core/.env.example`) so the table lines up with the seeded data's
actual local time rather than silently evaluating rush hour in UTC (the container default). A
real multi-city deployment would need this evaluated in each trip's own local time zone instead
— out of scope for a baseline heuristic.

## Throttled recompute — driven by location updates, not every tick

Recomputation is triggered from the same place driver locations actually land:
`ws/location-batch.ts#flushBatch` calls `eta.service.ts#handleDriverLocationUpdate` for every
driver in a flushed batch (Phase 5). That function looks up the driver's one active
(`matched`/`in_progress`) trip, if any, and delegates to the shared throttle check.

**The throttle** (`maybeRecomputeEta` in `eta.service.ts`): recompute only if **either**
threshold is crossed since the last computed value for this trip —

- `ETA_RECOMPUTE_INTERVAL_MS` (default 15s) has elapsed, **or**
- the driver has moved `ETA_RECOMPUTE_DISTANCE_METERS` (default 200m) from the position the
  last ETA was computed at (using the same haversine function, so "has it moved enough" and "how
  far away is it" share one implementation) —

whichever comes first. The last computed value (`etaSeconds`, `distanceMeters`, `computedAtMs`,
and the position it was computed from) is cached in Redis
(`src/repositories/eta.repository.ts`, key `trip:{id}:eta`) — ETA is derived/live data, not
durable source-of-truth state, so it lives in Redis rather than as new Postgres columns on
`trips` (same durable-vs-live split as `docs/redis-geo.md`).

`GET /trips/:id/eta` **reuses the exact same throttled check** rather than always recomputing on
read — a GET request opportunistically triggers a recompute only if the same thresholds say it's
due, so the endpoint is self-healing (never permanently stuck on a missing value just because the
location-update hook hasn't run yet) without defeating the point of throttling in the first
place.

**Verified with an explicit count assertion, not "looks throttled" in logs**
(`test/eta.service.test.ts`, "eta.service: throttled recompute"): calls
`handleDriverLocationUpdate` directly with controlled synthetic timestamps/positions (no real
sleeps), and asserts the cached `computedAtMs` — proof a recompute did or didn't happen —
stays unchanged across a sub-threshold move/elapsed-time tick, and changes exactly when a
threshold is crossed. Two tests isolate the distance threshold and the time threshold
independently (each with the other threshold effectively disabled), so the assertions are
unambiguous about which one triggered the recompute.

## Trip phase decides the ETA target

- `matched` (driver assigned, not yet picked up the rider): ETA targets **pickup**.
- `in_progress` (rider onboard): ETA targets **dropoff**.

(`in_progress` has no code path that reaches it yet — no endpoint currently transitions a trip
there — but the schema/enum already defines it from Phase 1, so the ETA logic handles it
correctly in advance rather than needing a later change.)

## Edge cases — clear, distinct responses, never a crash or a stale number

`GET /trips/:id/eta` always returns **200** with a `status` field (a 404 is reserved for a
genuinely unknown trip id) — every case below is a valid, meaningful answer to "what's the ETA,"
not an error condition:

| `status` | When | `etaSeconds` |
| --- | --- | --- |
| `no_driver_assigned` | Trip has no `driverId` yet (still `requested`) — ETA doesn't mean anything before a driver exists to be en route. | `null` |
| `trip_completed` | Trip status is `completed`. | `0` — arrived, not a stale leftover figure. |
| `trip_cancelled` | Trip status is `cancelled`. | `null` — not even 0; the trip was never completed. |
| `stale_location` | Driver has no location at all yet, **or** their last update is older than `ETA_STALE_LOCATION_MS` (default 60s). | The **last cached value** if one exists, else `null` — flagged as stale rather than silently presented as current, but not thrown away either if a reasonable prior estimate exists. |
| `ml_unavailable` | Phase 10, `ETA_MODE=ml` only — an ML attempt just failed and there's no fallback configured. | The last cached value if one exists (from whichever engine produced it), else `null` — same graceful-degrade shape as `stale_location`, different cause. See `docs/eta-integration.md`. |
| `ok` | Driver assigned with a location fresher than the staleness threshold. | The (possibly just-recomputed) current estimate. |

`driverLocationAgeMs` is included on every non-`no_driver_assigned`/non-terminal response,
so a caller can see exactly how stale a number is even in the `ok` case, not just when flagged.

**Why a dedicated `ETA_STALE_LOCATION_MS` (default 60s) instead of reusing `DRIVER_STALE_MS`
(90s, Phase 3)**: those two thresholds answer different questions. `DRIVER_STALE_MS` asks "has
this driver gone silent enough that we should consider them offline" — a connectivity/liveness
check. `ETA_STALE_LOCATION_MS` asks "is this specific position still good enough to compute a
trustworthy ETA from" — for a moving vehicle, a 60-second-old position is already a meaningfully
worse estimate than a fresh one, well before the driver would be considered disconnected. Kept
independently configurable rather than conflated into one number.

**Verified explicitly, not just handled by luck** (`test/eta.service.test.ts`, "getTripEta edge
cases"): a dedicated test for each row above, including one that primes a real cached ETA, then
backdates the driver's last-updated timestamp past the threshold, and asserts the response is
flagged `stale_location` while still surfacing the last known (not fabricated-fresh) value.

## Verifying it yourself

```
cd core
npm test
```

- `test/eta-haversine.test.ts` — known-distance validation (above).
- `test/eta-heuristic.test.ts` — rush-hour table lookups (including boundary
  inclusivity/exclusivity and a custom table, proving it's genuinely table-driven) and
  `estimateEta`'s combination of distance/speed/multiplier.
- `test/eta.service.test.ts` — the throttle count assertions, every edge case above, the
  matched-vs-in_progress pickup/dropoff targeting, and `GET /trips/:id/eta` over real HTTP.

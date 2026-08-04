# Historical Trip Data Simulator (Phase 8)

A seeded, reproducible generator that fabricates a plausible historical trip dataset with real,
learnable duration signal — training data for the ETA regression model (Phase 9). Nothing here
comes from real rides (there is no live GPS/traffic feed yet); every figure is synthetic, but
deliberately structured so a model has genuine patterns to find.

## Where it lives, and why a dedicated table

`core/scripts/lib/trip-simulator.ts` (pure generation logic, no I/O) + `core/scripts/simulate-historical-trips.ts`
(CLI: generate, persist, summarize). Run via `npm run simulate:trips` from `core/`.

Persisted into a **new, dedicated `training_trips` table** (migration
`1735700007000_create-training-trips.js`), not into `trips` + `location_history` from Phase 1.
Reasoning:

- `trips` is real operational state — the rest of this system (matching, ETA, WebSocket
  notifications) reads and writes it. Filling it with thousands of fully-synthetic historical rows
  would conflate "live system state" with "training corpus" and pollute every other feature's
  dev/test queries against that table.
- The training corpus needs columns that have no meaning for a real trip: the naive baseline
  figures, and each of the three independently-injected variance factors (see below), stored
  explicitly so Phase 9 can inspect or use them directly rather than reverse-engineering them from
  pickup/dropoff coordinates at training time.
- `training_trips` has no FK to `riders`/`drivers` — these rows don't represent anything that
  happened to a real rider or driver, so there's nothing to reference. This also means the whole
  dataset can be regenerated or deleted freely without touching operational data.

## Reproducibility: seed + config, not wall-clock time

`generateTrips(config)` runs one seeded PRNG (`createSeededRandom`, the same mulberry32 used in
`core/scripts/seed.ts`) and derives every random choice from it in a fixed order — pickup/dropoff,
requested-hour, circuity, noise. Given the same `SimulatorConfig`, it is byte-identical every time
(`test/trip-simulator.test.ts`).

Critically, `endDate` (the reference point the simulated date range counts back from) **defaults
to a fixed constant** (`2026-01-01`, local time), not `new Date()`/wall-clock "now" — otherwise
running the script on a different day would silently shift the whole dataset even with the same
seed. `SIM_SEED`, `SIM_TRIP_COUNT`, `SIM_DAYS`, `SIM_END_DATE` (env vars, all optional) together
form the full reproducibility contract: same values in, same dataset out, regardless of when the
script actually runs.

Re-running with the same seed **replaces** that seed's rows (`DELETE FROM training_trips WHERE
simulation_seed = $1` before inserting) rather than accumulating duplicates — the same idempotency
pattern as Phase 1's `seed.ts`, verified in `test/training-trips-db.test.ts`. Rows from different
seeds coexist independently, so multiple generated datasets can sit in the same table at once.

## The duration formula — three independent, documented variance sources

The prompt's core requirement: don't make `actual duration = distance / constant speed`, or a
regression model has nothing to learn. Every trip gets both a **naive** figure (the deliberately
dumb baseline) and an **actual** figure (the simulated ground truth):

```
naive_distance_meters  = haversine(pickup, dropoff)
naive_duration_seconds = naive_distance_meters / avgSpeedMetersPerSecond   // no adjustment at all

actual_distance_meters  = naive_distance_meters * circuityFactor           // road network vs straight-line
actual_duration_seconds = (actual_distance_meters / avgSpeedMetersPerSecond)
                          * timeOfDayMultiplier
                          * zoneDensityFactor
                          * noiseFactor
```

`avgSpeedMetersPerSecond` defaults to **8 m/s**, matching `ETA_AVG_SPEED_MPS`'s default
(`docs/eta.md`) so the simulated ground truth and the live heuristic share the same baseline
assumption.

| Factor | Range / shape | Independent of | Rationale |
| --- | --- | --- | --- |
| `circuityFactor` | uniform(1.15, 1.35) | everything else | Real roads aren't straight lines — actual driving distance is always longer than haversine distance. A fixed, documented range rather than a road-network simulation (out of scope; that's an OSRM-style integration, a much later phase). |
| `timeOfDayMultiplier` | `getRushHourMultiplier(requestedAt)` — **reused directly from `src/services/eta-heuristic.ts`** (Phase 7) | location, noise | Deliberately shares the exact table the live heuristic already uses (7-9am 1.4x, 4-7pm 1.5x) — see "why the ML model still has room to beat the heuristic" below. |
| `zoneDensityFactor` | `1 + 0.6 * exp(-distanceFromCenterKm / 3)` — see `computeZoneDensityFactor` | time, noise | A stand-in "denser downtown = slower" proxy: 1.6x right at the city center (Union Square/Financial District, the same reference point used elsewhere in this project's tests), decaying smoothly to ~1.0x by ~10km out. There's no real zone/neighborhood data to calibrate against, so this is a deliberately simple, monotonic, explainable function of distance from center rather than a fabricated zone lookup table. |
| `noiseFactor` | uniform(0.85, 1.15) | everything else | Pure per-trip randomness — a slightly different route, one more red light. No learnable pattern by design: this is the irreducible error a well-fit model should *not* be able to fully explain away, which is realistic and prevents a suspiciously perfect fit. |

**Why reusing the exact rush-hour table doesn't make the ML model pointless**: the live heuristic
(Phase 7) only ever applies `timeOfDayMultiplier`. The simulated ground truth *also* varies with
`zoneDensityFactor`, which the heuristic has zero awareness of. A model trained on this data has
genuine room to beat the heuristic by picking up the location-based (density) signal the heuristic
can't see — not just by re-deriving the same rush-hour table it was already given.

Trip request *volume* by hour (a separate concern from how slow an in-progress trip is) is
controlled by `HOURLY_REQUEST_WEIGHTS` — a hand-authored, plausible rideshare demand curve (low
overnight, morning-commute rise, steady midday, a taller evening-commute + nightlife peak),
explicitly *not* calibrated to real ridership data, same as `RUSH_HOUR_TABLE` itself. Day-of-week
is not separately modeled (uniform across the simulated range) — a documented scope
simplification, not an oversight.

## A known, scoped timezone caveat

`generateTrips` builds each `requestedAt` using **local** `Date` getters/setters, and
`getRushHourMultiplier` reads `Date.prototype.getHours()` — both in the *process's* local time
zone, pinned to `America/Los_Angeles` via `TZ` (`core/.env`, same as the live service, see
`docs/eta.md`'s identical caveat). Postgres stores `timestamptz` in UTC and `EXTRACT(HOUR FROM
...)` reads back in the *session's* time zone (UTC by default) — not the same zone generation
used. The summary query below explicitly does `requested_at AT TIME ZONE 'America/Los_Angeles'`
before extracting the hour, specifically to undo that mismatch. **This was caught live**: the
first real run showed the "rush hour" buckets landing on the wrong hours entirely (an ~8h Pacific/
UTC shift) until this conversion was added — see the verification run below for the corrected,
consistent output.

## Verifying it yourself

```
cd core
npm run migrate:up          # creates training_trips if not already present
npm run simulate:trips      # SIM_SEED / SIM_TRIP_COUNT / SIM_DAYS / SIM_END_DATE env overrides
```

**Real captured run** (`SIM_SEED=42`, the default, 5,000 trips, against a live Docker Postgres —
not hypothetical numbers):

```
Generating 5000 trips (seed=42, days=30, endDate=2026-01-01T08:00:00.000Z)...

=== Historical trip simulator summary ===
simulation_seed:     42
row count:           5000
date range:          2025-12-03T08:35:15.000Z .. 2026-01-02T07:51:39.000Z
avg actual duration: 1298.2s
avg naive duration:  753.1s

Duration/speed by hour-of-day:
hour | trips | avg duration (s) | avg speed (m/s)
   0 |    52 |           1114.1 |            6.94
   1 |    45 |           1108.2 |            7.04
   2 |    37 |           1067.1 |            6.89
   3 |    31 |            837.9 |            6.89
   4 |    57 |           1298.5 |            6.68
   5 |   105 |           1124.6 |            6.85
   6 |   173 |           1175.4 |            6.92
   7 |   331 |           1585.1 |            4.89 <- rush hour
   8 |   385 |           1504.8 |            4.92 <- rush hour
   9 |   319 |           1114.5 |            6.80
  10 |   214 |           1088.8 |            6.88
  11 |   175 |           1093.8 |            6.86
  12 |   213 |           1045.6 |            6.91
  13 |   188 |           1101.2 |            6.91
  14 |   209 |           1127.7 |            6.89
  15 |   230 |           1176.7 |            6.78
  16 |   254 |           1798.8 |            4.54 <- rush hour
  17 |   309 |           1705.6 |            4.56 <- rush hour
  18 |   437 |           1668.7 |            4.59 <- rush hour
  19 |   385 |           1151.7 |            6.79
  20 |   308 |           1107.8 |            6.88
  21 |   233 |           1143.7 |            6.89
  22 |   198 |           1091.7 |            6.88
  23 |   112 |           1088.0 |            6.85

Rush hour vs off-peak (weighted by trip count):
  avg duration: rush=1641.7s  off-peak=1118.7s  (+46.7%)
  avg speed:    rush=4.71m/s  off-peak=6.86m/s  (-31.3%)
  PASS: rush-hour avg duration is 46.7% higher than off-peak (>= 15% threshold) — visible signal present.
```

The hourly trip counts also visibly track `HOURLY_REQUEST_WEIGHTS`'s demand curve (peaks at
7-8 and 16-19, trough around 2-3am), independent evidence the time-of-day sampling is working as
designed, not just the duration multiplier.

**Reproducibility, confirmed by actually re-running it**: running `npm run simulate:trips` again
immediately afterward (same default seed, no other changes) produced an **identical** summary —
same row count (5000), same date range down to the second, same avg durations, same per-hour
counts and figures in every row.

**Row count / date range spot-checked directly against Postgres** (not just trusting the script's
own printed summary):

```sql
SELECT count(*), min(requested_at), max(requested_at)
FROM training_trips WHERE simulation_seed = 42;
--  count |          min           |          max
-- -------+------------------------+------------------------
--   5000 | 2025-12-03 08:35:15+00 | 2026-01-02 07:51:39+00
```

Matches the script's printed summary exactly.

**Different seeds coexist independently**, confirmed with a second run
(`SIM_SEED=7 SIM_TRIP_COUNT=1000 npm run simulate:trips`) followed by:

```sql
SELECT simulation_seed, count(*) FROM training_trips GROUP BY simulation_seed ORDER BY simulation_seed;
--  simulation_seed | count
-- -----------------+-------
--                7 |  1000
--               42 |  5000
```

## Tests

- `test/trip-simulator.test.ts` — pure logic, no DB: seeded-RNG determinism, weighted-hour
  sampling actually favors heavier hours, pickup/dropoff bbox + minimum-distance constraints, the
  density factor's exact value at the city center and monotonic decay outward, full-dataset
  reproducibility (`generateTrips` called twice with the same config `toEqual`s), a different seed
  producing a different dataset, actual duration never degenerating to naive duration, and — the
  core acceptance criterion, checked in-memory with an explicit threshold assertion (not "looks
  higher") — rush-hour trips averaging at least 15% longer duration than off-peak trips across
  8,000 generated rows.
- `test/training-trips-db.test.ts` — real Postgres round-trip: every persisted field matches what
  was generated, re-running the same seed replaces rather than duplicates rows, and rows from
  different seeds don't interfere with each other.

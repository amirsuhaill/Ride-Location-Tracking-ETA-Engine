# Surge Pricing Simulation (Phase 13)

Per-zone surge multipliers driven by the live ratio of open trip requests to available online
drivers, updated on a fixed interval (never per-request), smoothed and bounded, and factored into
a fare estimate returned on trip request.

## Zones: geohash cells, reusing Phase 12's implementation

A "zone" is a geohash cell (`core/src/geo/geohash.ts`, Phase 12) at a fixed bit precision chosen
from `SURGE_ZONE_RADIUS_METERS` (default 2,000m) via `precisionForRadius` — the same technique
already used to size the custom spatial index's buckets, applied here to size pricing zones
instead. No new spatial-indexing code was needed for this phase; `cellOf`/`cellHash`/`decode`
are reused directly.

## Where the state lives

Surge multipliers are **derived, live state** — recomputed from current trips/drivers, never a
fact about the world in their own right — so they live in Redis (one Hash, `surge:state`, one
field per zone), the same durable-vs-live split used throughout this project (`docs/redis-geo.md`,
`docs/eta.md`). Nothing is added to Postgres for this phase.

## Why an interval, not per-request

Computing "requests ÷ drivers, per zone" fresh on every single `GET /surge` or `POST /trips` call
would mean every request pays the cost of scanning all open trips and all online drivers — and,
worse, would make the multiplier jitter with every single new request or driver coming online,
which is a bad rider experience (a price that changes between viewing a quote and tapping
"request" erodes trust more than a price that's a few seconds stale). Instead,
`surge.service.ts#computeAndUpdateSurge()` runs on a fixed background interval
(`SURGE_UPDATE_INTERVAL_MS`, default 15s — within the requested 10-30s range), and every read
(`getSurgeMultiplierForLocation`, the `GET /surge` endpoint, the fare estimate) is a **pure Redis
lookup of whatever that last run computed** — it never triggers a recompute itself. Verified
directly: `test/surge.test.ts`'s "does not recompute on every request" test adds a fresh burst of
demand and reads the multiplier 20 times in a row without calling `computeAndUpdateSurge()` again
— every read returns the exact same (now-stale) value — and only changes once the function is
actually called again.

## The computation, per zone

```
rawRatio          = openRequestsInZone / max(onlineDriversInZone, 1)
targetMultiplier  = requestCount < MIN_SAMPLE_REQUESTS
                       ? MIN_MULTIPLIER                      // not enough signal to trust — baseline
                       : clamp(rawRatio, MIN_MULTIPLIER, MAX_MULTIPLIER)

delta             = clamp(targetMultiplier - previousMultiplier, -MAX_CHANGE_PER_INTERVAL, +MAX_CHANGE_PER_INTERVAL)
newMultiplier     = clamp(previousMultiplier + delta, MIN_MULTIPLIER, MAX_MULTIPLIER)
```

| Config | Default | What it guards |
| --- | --- | --- |
| `SURGE_MIN_SAMPLE_REQUESTS` | 3 | The "1 request, 0 drivers shouldn't spike" case — below this many *open requests* in a zone, the multiplier targets baseline regardless of how extreme the raw ratio would be. This is deliberately based on request *count*, not some combined request+driver sample size, because the real failure mode is a lone rider's request getting quoted an absurd price off a single data point — a zone with 0 requests and 1 driver isn't a pricing decision waiting to happen at all. |
| `SURGE_MIN_MULTIPLIER` | 1.0 | Surge never discounts below baseline. |
| `SURGE_MAX_MULTIPLIER` | 3.0 | Surge never exceeds 3x, no matter how extreme the ratio. |
| `SURGE_MAX_CHANGE_PER_INTERVAL` | 0.3 | Smoothing — a zone can move by at most this much, up or down, per interval, so one noisy interval can't thrash the price. |
| `SURGE_UPDATE_INTERVAL_MS` | 15,000 | How often the above runs. |
| `SURGE_ZONE_RADIUS_METERS` | 2,000 | Zone size (fed into `precisionForRadius`, Phase 12). |

A zone that previously had demand but currently has none (0 open requests) also targets baseline
(0 < `SURGE_MIN_SAMPLE_REQUESTS` always) — so it decays back toward 1.0 at the smoothing rate over
subsequent intervals rather than staying stuck at its last computed value forever.
`computeAndUpdateSurge()` revisits every zone that has *either* current signal *or* a
previously-stored multiplier each run, specifically so this decay actually happens.

## Fare estimate

`fare.service.ts#estimateFare(pickup, dropoff, avgSpeedMetersPerSecond)`:

```
distanceMeters = haversine(pickup, dropoff)
etaSeconds     = distanceMeters / avgSpeedMetersPerSecond   // same baseline speed as docs/eta.md
subtotalCents  = FARE_BASE_CENTS + (distanceMeters/1000) * FARE_PER_KM_CENTS + (etaSeconds/60) * FARE_PER_MINUTE_CENTS
totalCents     = round(subtotalCents * surgeMultiplierForPickupZone)
```

All money is integer cents (never float currency). This is a point-in-time **estimate returned on
`POST /trips`, not persisted** — the same derived-not-durable treatment as ETA (`docs/eta.md`);
the actual fare a rider is eventually charged (post-trip, using real distance/duration) is out of
scope for this phase.

## `GET /surge`

```
GET /surge                    -> { zones: [ { zoneId, center: {lat,lng}, multiplier, requestCount, driverCount, updatedAt }, ... ] }
GET /surge?lat=X&lng=Y        -> { lat, lng, multiplier }
```

## Verified scenarios (`test/surge.test.ts`)

- **Demand-spike isolation**: a zone with 6 open requests and 1 driver rises above baseline while
  a separate, balanced zone (1 request, 2 drivers) stays at exactly baseline — asserted in the
  same test run, proving zones don't leak into each other.
- **Minimum-sample floor**: 1 request, 0 drivers → stays at exactly baseline (below
  `SURGE_MIN_SAMPLE_REQUESTS`).
- **Ceiling**: 10 requests, 0 drivers (a raw ratio of 10) → capped at exactly the configured
  `SURGE_MAX_MULTIPLIER`, not 10x.
- **Floor**: 3 requests, 20 drivers (ratio 0.15) → stays at exactly `SURGE_MIN_MULTIPLIER`, not a
  discount below it.
- **Smoothing**: a zone whose target is the ceiling only moves by `SURGE_MAX_CHANGE_PER_INTERVAL`
  per `computeAndUpdateSurge()` call — verified across the first two intervals explicitly, then
  confirmed to eventually converge to the true target after enough further intervals.
- **Not per-request**: reads during a burst of new demand return the same value until
  `computeAndUpdateSurge()` is explicitly called again.

## Real, live verification

Against a real Docker Postgres + Redis + `core` (production default config — `SURGE_UPDATE_INTERVAL_MS=15000`,
`SURGE_MIN_SAMPLE_REQUESTS=3`, `SURGE_MIN_MULTIPLIER=1.0`, `SURGE_MAX_MULTIPLIER=3.0`,
`SURGE_MAX_CHANGE_PER_INTERVAL=0.3` — no test overrides): one zone was set up with 6 open trip
requests and 1 online driver (a genuine demand spike), a second, unrelated zone with 1 request and
2 online drivers (below the minimum sample size — must stay at baseline).

```
$ curl http://localhost:3000/surge
{"zones": []}                                    # nothing yet — no interval has run

# ... 6 open trips + 1 driver in zone A, 1 open trip + 2 drivers in zone B ...

# a little while later, after several real 15s SURGE_UPDATE_INTERVAL_MS ticks have run on
# their own schedule (smoothing — 0.3/interval — means reaching the 3.0 ceiling from baseline
# takes several real ticks, not one):
$ curl http://localhost:3000/surge
{
  "zones": [
    {
      "zoneId": "20334525",
      "center": { "lat": 37.781982421875, "lng": -122.40966796875 },
      "multiplier": 2.8,
      "requestCount": 6,
      "driverCount": 1,
      "updatedAt": "2026-08-04T12:10:26.106Z"
    },
    {
      "zoneId": "20335924",
      "center": { "lat": 37.760009765625, "lng": -122.14599609375 },
      "multiplier": 1,
      "requestCount": 1,
      "driverCount": 2,
      "updatedAt": "2026-08-04T12:10:26.106Z"
    }
  ]
}

# one more real tick later, zone A reaches the full ceiling:
$ curl "http://localhost:3000/surge?lat=37.7749&lng=-122.4194"
{ "lat": 37.7749, "lng": -122.4194, "multiplier": 3 }

# and the fare estimate on a fresh trip request in that same zone reflects it exactly:
$ curl -X POST http://localhost:3000/trips -d '{"riderId":"...","pickup":{"lat":37.7749,"lng":-122.4194},"dropoff":{"lat":37.8044,"lng":-122.2712}}'
{
  ...,
  "fareEstimate": {
    "currency": "USD",
    "baseCents": 250,
    "distanceCents": 2014,
    "timeCents": 699,
    "subtotalCents": 2964,
    "surgeMultiplier": 3,
    "totalCents": 8892          # = round(2964 * 3), exactly
  }
}
```

Zone B — sharing the same running server, the same background job, the same interval — never
moved off baseline the entire time, confirming isolation live, not just in the mocked-timer test
suite.

**A note on constructing this scenario**: the real matching flow (`docs/matching.md`) resolves
trip requests very quickly — a driver is either found and offered (locking them for the offer
window) or the trip cancels with `no_drivers_available` within milliseconds. Because a locked
driver still counts as "online" for this feature's Postgres-based supply count, a genuinely
*sustained* backlog of unmatched requests exceeding available drivers is naturally rare in normal
operation (this system resolves demand quickly by design) — it takes a real, sustained
overload (arrival rate genuinely outpacing matching) to produce it live, which a handful of
manually-created requests in a demo doesn't reproduce on its own. For this live check, the open
trip rows were inserted directly (same technique `test/surge.test.ts` uses) so the scenario
reflects a genuine "6 requests waiting, 1 driver available" snapshot without fighting matching's
own (correctly) fast resolution — the surge *computation and serving* path is exactly what a real
overload would exercise; only how quickly requests naturally pile up to trigger it differs between
this demo and a genuinely overloaded system.

## Verifying it yourself

```
cd core
npm test                 # includes test/surge.test.ts
npm run dev               # or docker compose up
curl http://localhost:3000/surge
curl -X POST http://localhost:3000/trips -d '{...}'   # response includes fareEstimate
```

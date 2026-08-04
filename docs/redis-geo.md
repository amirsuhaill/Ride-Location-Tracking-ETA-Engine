# Redis Geo Indexing & Nearest-Driver Query (Phase 3)

Redis holds the **live** view of where online drivers are right now. Postgres stays the
**durable** source of truth for driver identity and status (Phase 1/2) — Redis is never asked to
be durable; if it's flushed or restarted, drivers just reappear as they send their next location
update.

**Phase 12** implements a from-scratch geohash spatial index and benchmarks it head-to-head
against the Redis GEO path documented here — see `docs/custom-geo-index.md` for the real,
measured comparison (and the honest analysis of where each one wins).

**Phase 14** shards this same kind of Redis Geo keyspace by region (separate logical databases per
region, boundary-aware queries, region-crossing migration) — see `docs/sharding.md`.

## Key design

- `drivers:geo` — one Redis Geo sorted set (`GEOADD`/`GEOSEARCH`), one member per driver, scored
  by a geohash-derived value computed from `(lng, lat)`.
- `driver:{id}:state` — a hash holding `status` and `lastUpdatedAtMs` (epoch ms of the last
  write). Kept as a separate key because **Redis has no per-member TTL or metadata on sorted set
  entries** — only whole-key TTLs — so "is this specific driver's entry stale" has to live
  somewhere else.

Implementation: `core/src/repositories/drivers.geo.repository.ts`.

## Why GEOADD + HSET use a pipeline, not MULTI/EXEC

Every location write does both a `GEOADD` (position) and an `HSET` (status + timestamp) via
`redis.pipeline()` — one network round trip for both commands, which matters a lot once these
happen on every driver ping (Phase 4/5). This is "atomic-ish", not fully atomic: a pipeline
batches commands, it doesn't wrap them in a transaction the way `MULTI`/`EXEC` would, so there's
no rollback if one command in the batch fails and the other succeeds.

That's a deliberate choice, not an oversight: these two keys hold **ephemeral, frequently
overwritten live-location data**, not something with a durability or consistency invariant to
protect. If a partial write ever happened (e.g. the connection drops mid-pipeline), the worst
case is one key reflects a position one update behind the other for a few hundred milliseconds
until the driver's *next* location ping overwrites both again — an acceptable failure mode for
"last known good location," unlike a financial transaction or an inventory decrement. Reaching
for `MULTI`/`EXEC` here would trade a small amount of real correctness benefit (that we don't
need) for actual overhead on the hottest write path in the system.

## The staleness problem

**What happens if a driver disconnects without ever sending "offline"?** Without intervention,
their Redis entry would say "online" forever, and `/drivers/nearby` would keep dispatching riders
to a driver who isn't there.

Two layers handle this, one for correctness right now and one for cleanup shortly after:

1. **Query-time freshness check.** `searchNearby()` doesn't just filter on `status === "online"`
   — it also checks `now - lastUpdatedAtMs <= DRIVER_STALE_MS` (default 90s, `DRIVER_STALE_MS`).
   A driver who's gone quiet is excluded from results the moment they cross that threshold, even
   before anything has physically removed them from Redis. This is what makes nearby search
   correct independent of whether the reconciliation job has run yet.
2. **Background reconciliation job** (`src/services/reconciliation.service.ts`,
   `reconcileStaleDrivers`, run every `RECONCILE_INTERVAL_MS` — default 30s). It scans
   `driver:*:state` keys via **`SCAN`, not `KEYS`** — `KEYS` is O(n) and blocks Redis's single
   event loop for the entire keyspace scan; `SCAN` does the same O(n) total work but in small
   non-blocking cursor increments, so it never stalls other clients on a busy instance. For any
   driver whose status is `online`/`busy` but stale, it:
   - removes them from `drivers:geo` (`ZREM`) so they're structurally gone from search, not just
     filtered out, and
   - corrects Postgres (`UPDATE drivers SET status = 'offline' ...`) so the durable record
     converges with reality too.

An explicit `PATCH /drivers/:id/status` to `offline` also immediately does the Redis side of this
(no need to wait for the reconciler) — see `updateDriverStatusInRedis`.

## What happens if Redis and Postgres disagree about a driver's status

This is the direct answer to that question: **Postgres is authoritative; Redis is a fast,
eventually-consistent live view that both feeds from and gets corrected by Postgres.**

- Normal path: a `PATCH .../status` or `PATCH .../location` writes Postgres first, then mirrors
  the result into Redis — Redis's copy is always *derived from* the Postgres write that just
  succeeded, not independently decided.
- Disagreement path: the only way they drift apart is silence (a driver process dies, a network
  partition, a client that never calls anything again). Redis has no way to know that happened
  except elapsed time, so staleness is the signal: no update within `DRIVER_STALE_MS` is treated
  as proof the driver is actually offline, and the reconciliation job pushes that conclusion back
  into Postgres. Until the job runs, `/drivers/nearby` has already stopped surfacing them (via the
  query-time freshness check above) — so the user-facing behavior is correct within milliseconds,
  and full convergence between the two stores follows within one `RECONCILE_INTERVAL_MS` window.
- The reconciliation job never guesses a driver back *online* — silence only ever moves a driver
  towards `offline`. Going online requires an explicit signal (a location ping or a status PATCH),
  which is the direction that actually needs a positive assertion of liveness.

## Why Redis GEO commands are O(log n) — and the tradeoff vs a linear scan

`GEOADD` stores each member in a plain Redis sorted set (`ZADD` under the hood), scored by an
11-character-precision geohash of `(lat, lng)` packed into a 52-bit integer. Sorted sets are
implemented as a skip list, so insert/update is **O(log n)** (n = members in the set).

`GEOSEARCH`/`GEORADIUS` work by:

1. Computing which geohash cell(s) cover the query circle/box.
2. Translating that into a small number of **score sub-ranges** and doing a skip-list range scan
   over each — O(log n + k) per range, where k is the candidates returned.
3. Post-filtering those candidates with an exact haversine distance check, since a geohash cell is
   a rectangle, not a circle — the range scan over-fetches slightly and the exact-distance pass
   prunes the false positives. (This same exact-distance pass is also what makes the classic
   "point just outside a cell boundary is actually closer than one deep inside a neighboring
   cell" problem a non-issue in practice: Redis checks a small grid of neighboring cells around
   the query point, not a single hard-edged cell, before the distance filter runs.)

**The tradeoff vs a naive linear scan** (compute haversine distance from the query point to
every driver, filter, sort): a linear scan is O(n) with no index-maintenance cost, and for very
small n it can even be faster in practice (no geohash/skip-list overhead). Redis GEO wins as n
grows — at thousands of drivers, touching O(log n + k) sorted-set entries instead of all n is the
difference between a sub-millisecond query and one that gets linearly slower with fleet size. The
cost of that win is the geohash approximation step (bullet 3 above) and the memory/CPU overhead of
maintaining the skip list on every write — worth it here because nearby-driver search is a
read-heavy, latency-sensitive hot path, and drivers-in-flight is a number that's only going to
grow.

## Bounding `/drivers/nearby` inputs

`radius` and `limit` are validated (`src/schemas/drivers.ts`) and **rejected with 400**, not
silently clamped, when out of bounds:

- `radius`: 1–50,000 meters (50km) — `NEARBY_MAX_RADIUS_METERS`.
- `limit`: 1–100 — `NEARBY_MAX_LIMIT`.

Rejecting rather than clamping was a deliberate choice: a caller asking for a 500km radius should
get a clear, immediate error, not a quietly-truncated 50km answer that looks like a correct
response to a different question. Internally, `searchNearby()` also over-fetches from Redis
(`limit × 5`, capped at 500 candidates) before filtering by status/freshness, so that a radius
full of busy/offline/stale drivers doesn't silently under-fill `limit` with fewer results than a
caller would expect.

## Verifying it yourself

```
cd core
npm test
```

`test/drivers-nearby.test.ts` seeds 100 fake driver locations directly into Redis and covers:
correct radius filtering + distance-sorted ordering, a boundary case (drivers placed just inside
vs. just outside the query radius), an empty-result case (no drivers in range), and the
online/offline/busy exclusion filter. `test/drivers-location.test.ts` covers the same exclusion
behavior end-to-end through the HTTP API. `test/reconciliation.test.ts` covers the staleness
convergence job directly.

### Measured load-shape numbers (captured from an actual run)

```
[load-shape] seeded 100 drivers in 23.1ms, nearby query (radius=10km, limit=20) returned 20 results in 3.7ms
```

The test asserts the query itself completes in under 500ms — a generous regression-guard bound
for a local single-Redis-round-trip query, not a load-test SLA (that's Phase 11, at a much larger
scale and with real network/backpressure conditions).

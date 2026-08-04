# Multi-Region Sharding (Phase 14)

Shards the geospatial layer by geography — separate Redis keyspaces per region, a documented
routing function, boundary-aware queries that merge and re-sort (not concatenate) across shards,
and a region-crossing migration path that never leaves a stale duplicate behind.

**Scope note, matching Phase 12's precedent**: this is a real, fully-tested, standalone module
(`core/src/geo/regions.ts` + `core/src/repositories/sharded-driver-geo.repository.ts`) —
not wired into the live matching/location-update path that Phase 3's
`drivers.geo.repository.ts` still backs today. The engineering problem this phase is actually
about — regional routing, boundary correctness, cross-shard migration — is fully solved and
verified against real, multi-database Redis below; swapping the production call sites
(`matching.service.ts`, `ws/location-batch.ts`, `reconciliation.service.ts`) over to it is
comparatively mechanical once this layer exists, and is called out as the concrete next step at
the end of this document rather than attempted here.

## Two adjacent regions, not two disconnected cities

`core/src/geo/regions.ts` defines two regions sharing one real boundary — the meridian at
**-122.386°** — rather than two cities hundreds of kilometers apart:

- **`sf`** — San Francisco, Phase 1's original bounding box, unchanged.
- **`oakland`** — an "East Bay" region of the same size immediately to `sf`'s east.

A shared border is what makes "query near a region edge" and "driver crosses a region boundary"
actually meaningful to test — two disconnected cities would never have a query near "the edge" at
all.

## Sharding key strategy

Each region gets its own **Redis logical database** (`SELECT 1` for `sf`, `SELECT 2` for
`oakland`) via a **separate `ioredis` connection** — a real, addressable separation at the Redis
protocol level, not a key-prefix convention layered on top of one shared keyspace. Both shards use
the identical key name (`drivers:geo`) internally; they can never collide because they're
different databases entirely. Region-to-shard membership tracking ("which shard is driver X
currently in") lives in a third place — the existing, unsharded `redis` client from earlier phases
(db 0, alongside `surge:state` etc.) — because it's routing metadata (control plane), not spatial
data (data plane), and every shard needs to agree on it regardless of which one currently holds a
given driver.

**Why logical DBs instead of key prefixes, and what it costs**: a key-prefix scheme
(`drivers:geo:sf`, `drivers:geo:oakland` in one shared DB) would have been simpler to set up (no
extra connections) but is a *weaker* form of isolation — nothing stops a bug from typo'ing a
prefix and silently reading/writing the wrong region's data, and it doesn't generalize to genuinely
separate physical Redis instances/hosts later without a rewrite. Separate logical DBs generalize
almost for free: swapping `new Redis(config.redisUrl, { db: region.redisDb })` for
`new Redis(region.connectionString)` — pointing each shard at a truly separate host — is a
one-line, per-region **connection-string change**, not a routing-logic change, because every
caller already goes through `shardFor(region)` rather than assuming a shared connection.

## Routing function

Two distinct routing functions for two distinct needs:

- **`regionForPoint(point): Region | null`** — writes. A driver's location belongs to *exactly
  one* shard. Containment is min-inclusive/max-exclusive in longitude for every region except the
  easternmost (also max-inclusive, so the outer edge of the whole simulated area isn't an
  exclusive dead zone) — so a point exactly on the shared boundary (`-122.386°`) belongs to
  `oakland` (the eastern neighbor), never both, never neither. Returns `null` for a point outside
  every simulated region (out of coverage) — `upsertDriverLocation` throws in that case rather
  than silently dropping the update or guessing a shard.
- **`regionsWithinRadius(point, radiusMeters): Region[]`** — reads. Every region whose bounding
  box is within `radiusMeters` of the query point, via the standard axis-aligned-bbox distance
  (clamp the point's lat/lng independently into each region's range, then haversine distance to
  that clamped point — 0 if the point is already inside). This is deliberately not "the point's
  own region plus its neighbors" as a special case — a plain distance-to-every-region filter
  naturally returns just the owning region when far from any border, several regions near a
  shared one, and none at all for a point wildly outside the simulated area, with no separate
  code path for any of those cases.

## Boundary queries: merge and re-sort, not concatenate

`searchNearby(center, radiusMeters, limit)` calls `regionsWithinRadius` to find every shard worth
asking, queries each one's `GEOSEARCH` independently (each shard's own results are correctly
sorted *among themselves*), then **flattens every shard's results into one list, sorts that whole
list by actual distance, and only then truncates to `limit`.** Concatenating each shard's
already-sorted results in shard order would be wrong the moment two shards both have candidates —
nothing guarantees shard A's closest result is closer than shard B's, so the combined list has to
be re-sorted as a whole.

**Proven, not just implemented** (`test/sharded-geo.test.ts`): a query point sits just inside
`sf`, near the boundary. Driver X sits in the *same* shard (`sf`) but ~615m from the query point.
Driver Y sits *across* the boundary in `oakland`'s shard, but only ~445m away — genuinely closer,
despite being in the "other" shard. The test asserts Y comes back **before** X. A
"concatenate-by-shard" implementation queried in `[sf, oakland]` order would have listed X (from
the query point's own region, queried first) ahead of Y regardless of actual distance — this test
is exactly what would catch that bug. A second test confirms the overall `limit` is enforced
*after* merging (not `limit` results from *each* shard), and a third confirms a query far from any
boundary never touches the other region's shard at all.

## Crossing a region boundary: no stale duplicate

`upsertDriverLocation(driverId, lat, lng)` looks up which shard this driver was in *last time*
(the control-plane tracking key). If the new location resolves to a **different** region, it
`ZREM`s the driver from the old shard **before** adding them to the new one, then updates the
tracking key. A driver who stays within the same region never touches the other shard at all (no
spurious removal-then-reinsert).

**Proven at two levels**:

- `test/sharded-geo.test.ts` — after moving a driver from `sf` to `oakland`,
  `isDriverInRegionShard(id, "sf")` is `false` **and** `getShardMemberCount("sf")` drops to `0` —
  not just "the driver doesn't show up in a nearby search anymore" (which a query-time filter
  could fake), but the raw sorted set in the old shard's own Redis database is actually empty.
- **Live, against a real Docker Redis container**, inspected directly via the container's own
  `redis-cli` (not through this project's code at all, to rule out a test-only illusion):

  ```
  $ docker exec ride-tracking-redis-1 redis-cli -n 1 ZRANGE drivers:geo 0 -1   # sf shard
  (empty)
  $ docker exec ride-tracking-redis-1 redis-cli -n 2 ZRANGE drivers:geo 0 -1   # oakland shard
  demo-driver-oak
  demo-driver-sf
  $ docker exec ride-tracking-redis-1 redis-cli -n 0 GET driver-shard-region:demo-driver-sf
  oakland
  ```

  (A driver named `demo-driver-sf` was placed in `sf`, then moved to `oakland` — its old shard's
  keyspace is genuinely empty afterward, confirmed independent of this project's own read path.)

**A real debugging note, kept honest rather than edited out**: the first attempt at this exact
live check appeared to fail — the container's `redis-cli` showed nothing, even though a
verification script reported correct-looking results. The cause: this machine already had a
*native* Homebrew Redis server bound to `127.0.0.1:6379`, entirely unrelated to this project's
Docker setup — a script connecting to `redis://localhost:6379` from the host silently talked to
that native process instead of the Docker container mapped to the same port. Remapping the
container to an unambiguous host port (`6389`) and re-running resolved it immediately (the numbers
above are from that corrected run). Worth remembering for anyone else on a machine with a
pre-existing local Redis: `localhost:<port>` is not guaranteed to mean "the Docker container," only
`docker exec <container> redis-cli` is.

## Rebalancing a hot shard: a concrete mechanism, not "add more shards"

If one region (say `sf`) gets disproportionately busy relative to `oakland`, the fix is **finer
geohash-prefix repartitioning**, not a vague "scale out":

1. Stop defining regions as hand-picked bounding boxes and instead define them as a
   **geohash-prefix-to-shard map** (e.g., a `Map<string, Region>` keyed by a fixed-length geohash
   prefix — `core/src/geo/geohash.ts`'s `cellOf`/`cellHash` from Phase 12 already produce exactly
   this kind of prefix). `regionForPoint` becomes "encode the point at the map's fixed precision,
   look up its prefix" instead of a bbox scan — a strict generalization of what this phase already
   does, not a new mechanism.
2. When a shard's load crosses a threshold, **split its prefix range**: take the busy shard's
   cells, subdivide them one geohash level finer (each cell splits into ~4), and reassign *half*
   of the finer cells (by actual measured load, not just geographically down the middle) to a
   brand-new shard (a new Redis logical DB or, at genuine scale, a new physical instance).
   Critically, **the exact same migration mechanism this phase already implements handles the
   move**: any driver whose current geohash cell now maps to the new shard gets `ZREM`'d from the
   old one and `GEOADD`'d to the new one, exactly like a driver crossing `sf`→`oakland` today —
   repartitioning is "trigger a bulk migration event," not a different code path.
3. Only the keys in the *reassigned* finer cells move — not every key in the busy shard — because
   geohash prefixes are geographically local by construction. This is the specific reason this
   project prefers geohash-prefix repartitioning over textbook **consistent hashing with virtual
   nodes**: consistent hashing (hash the driver ID or an arbitrary point onto a ring, assign ring
   segments to shards) also bounds how many keys move when a shard is added — but it hashes away
   geography, so two drivers a block apart could land on unrelated shards. That would break this
   phase's whole "a query near a boundary only ever needs to check *geographically adjacent*
   shards" property, forcing every query to fan out to every shard just in case. Consistent
   hashing is the right tool when keys have no natural locality to preserve; geohash-prefix
   repartitioning is the right tool here specifically because locality (nearby points, nearby
   shards) is the property the rest of this system's query pattern depends on.

## Verifying it yourself

```
cd core
npm test   # includes test/sharded-geo.test.ts — routing, boundary merge, migration
```

`test/sharded-geo.test.ts`:

- Pure `regionForPoint`/`regionsWithinRadius` routing — boundary ownership, out-of-coverage
  handling, radius-dependent adjacent-shard inclusion.
- A driver deep in one region is found from that region and invisible from the other.
- Upserting an out-of-coverage point is rejected, not silently dropped.
- `removeDriver` clears whichever shard currently holds a driver.
- **Boundary merge**: two drivers in different shards, the farther one in the query point's own
  region — asserts the closer cross-shard result sorts first, and that the merged `limit` isn't
  "`limit` per shard."
- **Migration**: moving a driver between regions leaves `ZCARD` at `0` in the old shard and
  correctly populated in the new one; staying within one region never touches the other shard at
  all.

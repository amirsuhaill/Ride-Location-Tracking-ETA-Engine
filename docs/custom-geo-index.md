# Custom Spatial Index: Geohash, From Scratch (Phase 12)

A hand-built geohash-bucket spatial index (`core/src/geo/`), benchmarked head-to-head against the
real Redis GEO path from Phase 3, at the same dataset sizes used in Phase 11's load test. The
point of this phase isn't to replace Redis GEO in the running service (it doesn't — Redis GEO
stays the production path; this is a from-scratch implementation for demonstrating what it does
internally) — it's to answer, with real numbers, "how do you index moving objects efficiently,"
including being honest about where a hand-rolled version loses to Redis.

## Choice: geohash, not a quadtree — justified by our actual read/write ratio, not in the abstract

**Geohash buckets update in O(1) (a hashmap move, no rebalancing); a quadtree's range queries
prune space more naturally but its rebalancing cost on frequent moves is worse.** Which one wins
depends entirely on how often this system reads vs. writes its position index — so the answer
comes from Phase 11's actual load test, not a general "which is theoretically superior" argument.

From Phase 11's load profile (`docs/load-testing.md`): 5,000 simulated drivers each sending a
location update every 2 seconds (**2,500 writes/sec**), concurrent with one new trip request every
500ms (**2 reads/sec** — each trip request triggers exactly one nearby-driver search,
`searchNearby`, regardless of fleet size). That's a **write:read ratio of roughly 1,250:1** at the
exact scale this system was measured at. This isn't a hypothetical skew toward writes — it's the
literal, measured shape of this system's real traffic: drivers report position constantly; a
"where's the nearest driver" query only happens once per ride request.

Given that ratio, a quadtree is the wrong structural choice for this system: every one of those
2,500 writes/sec would potentially need to walk down the tree, remove the point from its current
leaf, and re-insert it (possibly triggering a leaf split or a parent merge) — real, non-trivial
work multiplied by a workload that is overwhelmingly writes. A geohash bucket move, by contrast, is
"delete this id from one `Set`, add it to another" — O(1) regardless of how the tree the data
*would* have needed to rebalance might have looked. Read cost (a bounded neighborhood scan around
the query point) is the same story either way, dominated by density, not by which structure you
pick — and reads are rare enough here that even were they meaningfully slower, they'd barely move
the needle overall. **Geohash is the right choice for this system's actual access pattern**, and
not incidentally: it's the same choice Redis's own GEO implementation makes.

## Implementation (`core/src/geo/`)

- `geohash.ts` — pure encode/decode/grid-cell math. A bit-interleaved integer geohash (up to
  `MAX_BITS = 52`, matching the same total Redis's own internal "52-bit interleaved integer"
  representation uses), built around an explicit `(row, col)` grid-cell model rather than
  repeatedly re-bit-twiddling points, because the index needs to scan an arbitrary-sized block of
  grid cells around a query point (see below) — row/col arithmetic makes that a plain integer
  range instead of N individual re-encodes. Handles antimeridian wraparound (longitude) and pole
  clamping (latitude) explicitly, not as an afterthought — both are tested
  (`test/geohash.test.ts`).
- `geohash-index.ts` — `GeohashIndex`: a `Map<geohash, Set<id>>` of buckets at one fixed bit
  precision, chosen at construction time to match this system's real, essentially-fixed query
  radius (`MATCH_SEARCH_RADIUS_METERS`, 3km default) — a deliberate, honest simplification
  discussed below, not a generic arbitrary-radius structure.

### Nearest-neighbor and radius search, including the boundary-adjacent-cell problem

A point can sit anywhere within its own geohash cell — including a meter from the edge, with a
genuinely closer point sitting a meter away in the *neighboring* cell. Any implementation that
only scans the query point's own bucket gets this wrong. `GeohashIndex#radiusSearch`:

1. Computes how many grid cells the requested radius could possibly reach, given this index's
   fixed cell size (`ringCount = ceil(radius / cellSize) + 1` — the `+1` specifically accounts for
   the query point's own worst-case position at the far edge of its cell, not just the cell-to-
   cell distance).
2. Scans every cell in that `(2·ringCount+1)²` block around the query point's cell (wrapping
   longitude at the antimeridian, clamping latitude at the poles), unioning their buckets into a
   candidate set.
3. Filters candidates by *exact* haversine distance and sorts — the bucket scan only narrows the
   candidate set; correctness never depends on it being exact.

This makes `radiusSearch` **exhaustive for any radius**, not an approximation that happens to work
for radii close to the index's own cell size — explicitly verified in
`test/geohash-index.test.ts` with a test that places the query point deliberately within a
thousandth of its cell's edge and the target point just across that same boundary (confirmed, via
`cellHash`, to land in a genuinely different bucket): `radiusSearch` still finds it. A "scan only
my own cell" implementation would silently return nothing for that exact case.

`nearestNeighbors(center, k)` is `radiusSearch` run at successively doubling radii (starting from
this index's own cell size — a density-informed initial guess) until at least `k` results are
confirmed. This is more than a heuristic: because `radiusSearch` is exhaustive within whatever
radius it's given, having `≥ k` confirmed results at radius `R` *proves* those are the true `k`
nearest overall — nothing outside `R` could be closer than something already found inside it.

### An honest limitation this design accepts

`GeohashIndex` fixes its bucket precision once, at construction, to match this system's one real
query radius. Redis's sorted-set-by-integer-score approach doesn't need to make that tradeoff — it
can efficiently answer a query at *any* radius by scanning a differently-sized range of the same
sorted structure. This implementation instead handles a larger-than-expected radius by scanning
*more* cells at its fixed precision (still exhaustive, just less efficient at extreme radius
mismatches) rather than re-bucketing at a different precision. For a system with one dominant query
radius (this one), that's a fair, honest simplification; for a general-purpose spatial index
library, it wouldn't be. (This exact simplification turns out to be the story behind the 100K-scale
benchmark numbers below — see the analysis after the results.)

## Benchmark: real numbers, same dataset sizes as Phase 11's load test

**Environment**: same machine as Phase 11 (`docs/load-testing.md`) — 8-core / 8GB macOS host,
Redis `redis:7-alpine` in the Docker Desktop VM (3.83 GiB cap), `core`'s benchmark script run as a
native Node process (v24.11.1) connecting to that same Redis over `localhost:6379`. Query radius:
3,000m (matching `MATCH_SEARCH_RADIUS_METERS`'s default). KNN: k=10, using the *identical*
iterative-deepening-radius algorithm for both systems (Redis's `GEOSEARCH` has no native unbounded
"K nearest regardless of distance" mode, so both are benchmarked doing the same algorithm, not two
different ones). 100 sample queries per scale (or `min(100, N)` at N=100). Insert cost measured as
individual, non-pipelined operations for both — isolating the spatial index's own per-write cost,
not Phase 5/11's separate batching optimization layer, which is orthogonal to this comparison.

```
cd core
npm run benchmark:geo
```

### Insert (write) latency — per operation

| Scale | Custom (avg) | Redis (avg) | Custom is |
| --- | ---: | ---: | ---: |
| 100 | 6.7 µs | 119.9 µs | **18x faster** |
| 1,000 | 2.0 µs | 49.5 µs | **25x faster** |
| 100,000 | 2.1 µs | 43.1 µs | **20x faster** |

### Radius search latency (3,000m, limit 20)

| Scale | Custom p50 / p95 / p99 | Redis p50 / p95 / p99 | Winner |
| --- | --- | --- | --- |
| 100 | 0.10 / 0.18 / 0.48 ms | 0.22 / 0.41 / 0.78 ms | **Custom**, ~2x |
| 1,000 | 0.49 / 0.57 / 1.03 ms | 0.18 / 0.21 / 0.74 ms | **Redis**, ~2.7x |
| 100,000 | 56.0 / 62.7 / 82.0 ms | 5.3 / 8.0 / 30.1 ms | **Redis**, ~10x |

### K-nearest-neighbor latency (k=10)

| Scale | Custom p50 / p95 / p99 | Redis p50 / p95 / p99 | Winner |
| --- | --- | --- | --- |
| 100 | 0.09 / 0.12 / 0.42 ms | 0.43 / 0.60 / 0.91 ms | **Custom**, ~4.6x |
| 1,000 | 0.53 / 0.59 / 0.88 ms | 0.17 / 0.24 / 0.25 ms | **Redis**, ~3x |
| 100,000 | 69.1 / 83.1 / 92.7 ms | 0.20 / 0.40 / 1.3 ms | **Redis**, ~**350x** |

### Memory footprint at 100,000 entities

| | Bytes |
| --- | --- |
| Custom `GeohashIndex` (GC-forced `heapUsed` delta) | **~18.4 MB** |
| Redis (`used_memory` delta for the equivalent key) | **~7.1 MB** |

**Redis wins on memory by ~2.6x** — its native C sorted-set/skip-list encoding is more compact
than a JS `Map`/`Set`-based structure, which pays V8's per-object and per-Map-entry overhead on
top of the raw coordinate data three times over (a position map, a bucket-membership map, and an
id-to-bucket-hash map). (A non-GC-forced reading taken earlier read ~31MB — the GC-forced number
above is the trustworthy one; the gap between the two is exactly the kind of transient-garbage
noise forcing a GC collection before measuring is meant to eliminate.)

Every scale's benchmark run also cross-checked correctness: the custom index's radius-search
result set was confirmed to be a subset of Redis's own result set for the same query, at every
scale, every run.

## Honest analysis: where each one wins, and why

**Writes: the custom index wins decisively, everywhere — but mostly for an unglamorous reason.**
An in-process `Map`/`Set` mutation never leaves the process; a Redis write is a real network round
trip (loopback TCP, but still a socket, still kernel involvement, still Redis's own command
parsing) plus, underneath, its own O(log N) skip-list insert. **This is not really "my algorithm
beats Redis's algorithm"** — it's "code with no network hop beats code with one," which is a
different, if equally real, engineering fact. The honest, useful takeaway for a system-design
conversation isn't "hand-rolled beats Redis at writes," it's: *embedding an index in your own
process trades away the sharing/durability/multi-process-access Redis gives you, in exchange for
latency* — a real, common tradeoff (this is exactly why some systems maintain an in-memory
"hot" index backed by a shared durable store), not a verdict that hand-rolled code is better.

**Reads at low density (100 entities): a rough wash, tilting custom.** At 100 points spread across
the whole SF bounding box, both structures have almost nothing to scan; the custom index's
no-network-hop advantage still shows through, similar to writes.

**Reads at higher density (1,000, and dramatically at 100,000): Redis wins, and wins by more as
scale grows — this is the important, non-obvious finding.** The root cause is the exact
simplification flagged above: `GeohashIndex` fixes one bucket precision for its whole lifetime,
chosen so a cell is roughly the size of the benchmark's 3,000m query radius. At that precision
(24 bits — 12 bits per dimension), each cell is **~4,892m × ~7,735m** — and the benchmark's own SF
bounding box is only **~11,577m × ~11,265m**, i.e. the *entire test area spans only about 6 grid
cells total*. Every one of the 100,000 benchmark points is scattered across those same ~6 buckets
— roughly 16,000+ points per bucket — so a radius/KNN query's "scan the neighboring cells" step
degenerates into "linear-scan roughly the entire dataset and compute exact haversine distance for
each point," which is exactly the O(N) shape the 56ms/69ms numbers show. Redis's sorted-set range
scan has no such failure mode: its cost scales with `O(log N + result size)` regardless of how
densely points are packed into a small area, because it isn't committed to one fixed cell size at
all — it can effectively answer at whatever "precision" the query needs by scanning a
correspondingly-sized slice of one sorted structure.

**In short: for a dataset that's genuinely spread out relative to the fixed cell size chosen for
this index, the custom implementation is competitive or better; for a dataset packed more densely
into a small area than that fixed cell size assumes, it degrades toward a full scan, and Redis's
approach doesn't share that specific weakness.** A production-grade version of this index would
need either a multi-precision/hierarchical bucket scheme or the real sorted-structure-by-integer-
score design Redis actually uses — which is, in the end, the honest answer to "why does Redis do
it that way": not because bucketing-by-geohash is the wrong idea (it demonstrably wins on writes,
and on reads at low density) but because a *fixed*-precision bucket map is a simplification that
breaks down exactly where a general-purpose spatial index can't afford to break down — at high
density. This system's own real traffic pattern (Phase 11: ~2,500 location writes/sec against ~2
nearby-driver reads/sec) means writes dominate overwhelmingly — but the read side, when it does
happen, needs to stay fast regardless of how many drivers cluster in one neighborhood, which is
precisely the case this implementation is weakest at. That's the honest reason Redis GEO remains
the production path in this project rather than being replaced by the from-scratch version here.

## Tests

- `test/geohash.test.ts` — encode/decode round-trip within the decoded cell's own error bounds at
  6 different precisions, finer precision producing a strictly smaller error, `bitSplit`'s
  lng-gets-the-extra-bit convention, `neighborCells` returning 8 distinct non-center cells with the
  correct row/col deltas, explicit antimeridian-wraparound and pole-clamping cases, and
  `precisionForRadius` actually producing a cell at least as large as the requested radius across
  several radii.
- `test/geohash-index.test.ts` — insert/radius/remove/size basics, `upsert` correctly relocating a
  moved point to its new bucket (not just updating its recorded position), `nearestNeighbors`
  returning exactly k results in distance order and correctly expanding its search radius to reach
  a sparse far-away point, and — the acceptance-critical case — **two dedicated tests that
  deliberately place a point a thousandth of a cell-width from its cell's edge with a target just
  across that same boundary** (confirmed via `cellHash` to be a genuinely different bucket),
  proving both `radiusSearch` and `nearestNeighbors` still find it. A "scan only the query point's
  own cell" implementation is exactly what these two tests would catch failing.

## Verifying it yourself

```
cd core
npm test                      # includes test/geohash.test.ts and test/geohash-index.test.ts
npm run benchmark:geo         # requires a real, reachable Redis — see infra/docker-compose.yml
node --expose-gc -r tsx/cjs scripts/benchmark-geo-index.ts   # for the GC-forced memory reading
```

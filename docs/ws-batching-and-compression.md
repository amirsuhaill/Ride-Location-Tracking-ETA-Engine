# Location Ingestion Pipeline: Batching & Delta Compression (Phase 5)

Phase 4 gave each driver a per-connection rate limit (max one processed update per
`WS_DRIVER_THROTTLE_MS`, coalesced). Phase 5 adds a second, *fleet-wide* layer on top: instead of
every driver's throttle-released update immediately triggering its own Redis pipeline +
Postgres write + broadcast, updates are accumulated into a shared window and flushed together —
plus delta-compressed broadcast payloads to cut bandwidth. These are two independent
optimizations solving two different problems; the sections below cover each separately, then the
combined, measured results.

## Batching: fleet-wide, not per-driver

`src/ws/location-batch.ts` holds a single `Map<driverId, update>` (last-value-wins — same
coalescing idea as Phase 4's per-driver throttle, just at fleet scope) and a shared interval
timer (`WS_BATCH_WINDOW_MS`, default 300ms). On each tick, `flushBatch()`:

1. Snapshots and clears the pending map.
2. Bulk-updates Postgres in **one round trip** via `UPDATE ... FROM UNNEST(...)` over parallel
   arrays (`drivers.repository.ts#batchUpdateLocations`) — one query covers every driver in the
   batch, not one `UPDATE` per driver.
3. Bulk-upserts Redis in **one pipeline** covering every driver in the batch
   (`drivers.geo.repository.ts#upsertDriverLocationsBatch`) — 2×N commands, still a single
   `.exec()` round trip.
4. Broadcasts each driver's update to its subscribers (delta-compressed — see below).
5. Looks up which of this batch's drivers have an active trip and recomputes their ETA if due
   (`eta.service.ts`, Phase 7) — added after this page was written, and *not* originally batched
   like steps 2-3 above (it made one Postgres query per driver, unconditionally). At fleet scale
   that turned out to be exactly the kind of per-driver round trip this page's batching already
   existed to avoid — it saturated the Postgres connection pool badly enough to back up the whole
   flush. Fixed in Phase 11 (`docs/load-testing.md`) by batching this lookup too, the same way
   steps 2-3 already were.

At 1,000 drivers each sending ~once/second, this turns what would otherwise be up to ~1,000
separate two-command Redis pipelines and ~1,000 separate Postgres UPDATEs per second into at
most `1000 / (batchWindowMs / 1000)` ≈ 3-5 pipelines/updates per second (one per batch window),
each covering however many drivers reported in during that window.

### Why layer this on top of the per-driver throttle instead of replacing it

The throttle (Phase 4) protects against one chatty/malicious driver flooding the server —
per-connection, independent of fleet size. Batching (Phase 5) is a fleet-scale efficiency
concern — independent of any single driver's behavior. Collapsing them into one mechanism would
conflate "is this one client behaving" with "how do we handle many well-behaved clients
efficiently" — two different failure modes with two different natural timescales (seconds vs.
hundreds of milliseconds).

### Max batch window cap

`MAX_BATCH_WINDOW_MS = 1000` (`src/ws/runtime-config.ts`) — any configured `WS_BATCH_WINDOW_MS`
above this is clamped (with a logged warning), never silently ignored. Beyond ~1 second, a
"live" location stream stops feeling live regardless of how much Redis/Postgres efficiency it
buys — see the measured latency numbers below for exactly how added latency scales with window
size.

## Delta compression

Two independent techniques, applied per broadcast message:

1. **Quantized lat/lng deltas** instead of full floating-point coordinates.
2. **Omitted `status` field** when unchanged since the last message sent to that specific
   subscriber — "send only changed fields," the same idea the phase brief suggests, applied to
   a field that changes far less often than position.

### Quantization precision and its real-world error

`QUANTIZATION_STEP_DEGREES = 1e-5` (`src/ws/delta-compression.ts`). A delta is encoded as
`round((current - lastSent) / 1e-5)` — a small signed integer — and decoded as
`lastKnown + dLat * 1e-5`.

**Error bound**: at most half a quantization step per axis, i.e. `±5e-6` degrees.

- Latitude: 1° ≈ 111,320m everywhere → `5e-6° ≈ 0.56m` worst case per axis.
- Longitude: 1° ≈ `111,320 * cos(latitude)` m → at San Francisco's ~37.7°N, `111,320 * cos(37.7°)
  ≈ 87,975 m/°` → `5e-6° ≈ 0.44m` worst case.
- Combined worst-case radial error ≈ `√(0.56² + 0.44²) ≈ 0.71m`.

Civilian GPS accuracy is typically 3-5m, so this quantization error is **well below the noise
floor of the position data itself** — effectively lossless for a moving vehicle icon on a
rider's map. See `test/ws-delta-compression.test.ts` for the same derivation as a passing
assertion (`worstCaseLatErrorMeters < 1`), not just a comment.

**No error accumulation**: every delta is computed against the last ABSOLUTE (unquantized)
position that specific subscriber was actually sent — never against a previously-quantized/
reconstructed value. Each hop's rounding error is independent and bounded; a 50-message delta
chain has the same worst-case error as a single delta (`test/ws-delta-compression.test.ts`,
"a long chain of deltas does not accumulate error").

### Per-subscriber, not per-driver

Delta state (`lastSent: {lat, lng, status} | null`) lives on each `SubscriberInfo`, not on the
driver. A brand-new subscriber (or one that just resubscribed) always gets a full payload first,
**even if the driver has already been broadcasting deltas to other subscribers for a while** —
verified directly in `test/ws-delta-compression.test.ts` ("a subscriber's first update is full
even if the driver has already broadcast to others"). This is what makes the
first-update-ever/first-update-for-this-subscriber edge case correct by construction rather than
by luck: there's no global "has this driver ever sent a full payload" flag to get wrong.

### Wire format

```jsonc
// First message to a subscriber, or whenever status changes:
{ "type": "location", "driverId": "...", "lat": 37.7749, "lng": -122.4194, "timestamp": 171..., "status": "online" }

// Subsequent messages, status unchanged:
{ "type": "delta", "driverId": "...", "dLat": 12, "dLng": -7, "timestamp": 171... }

// Subsequent messages, status changed:
{ "type": "delta", "driverId": "...", "dLat": 12, "dLng": -7, "timestamp": 171..., "status": "busy" }
```

A client decodes by tracking `{lat, lng, status}` per subscription: on `"location"`, replace it
outright; on `"delta"`, add `dLat/dLng * 1e-5` to the last known position and keep the last known
`status` unless the message includes a new one. `decodeLocationMessage` in
`src/ws/delta-compression.ts` is the reference implementation of exactly this.

## Bandwidth: measured, not guessed

Tracked in-process by `src/ws/bandwidth-metrics.ts` (logged periodically via
`WS_BANDWIDTH_LOG_INTERVAL_MS`), and independently measured client-side by
`scripts/load-test-driver-fleet.ts`, which reconstructs what a full (non-delta) payload for each
received data point *would* have cost, regardless of what was actually sent — a fair, honest
before/after comparison, not a hypothetical.

**Real captured run** (1,000 simulated drivers, 15s, default 300ms batch window):

```
Drivers simulated:                          1000
Test duration:                               16.0s
Raw updates sent (whole fleet):              14000 (874.8/sec)
Sampled drivers (bandwidth/throughput):      50
Sampled broadcasts observed:                 700
Estimated fleet-wide processed throughput:   874.8 updates/sec
Avg bytes/message BEFORE (full-equivalent):  163.1
Avg bytes/message AFTER (actual, delta):     119.9
Bandwidth savings:                           26.5%
Added latency (send -> broadcast) avg/p50/p95/p99: 273ms / 270ms / 378ms / 378ms
```

**Why ~26%, not more**: the `driverId` (a 36-character UUID) is repeated in every message —
full or delta — and dominates this system's small message payload. Delta compression only
shrinks the lat/lng/status portion, so the overall percentage is naturally more modest than it
would be for a payload where the compressed fields dominate. We considered dropping `driverId`
from delta messages entirely (each subscriber already knows which driver they're subscribed to),
but kept it for message self-description and debuggability, and because it costs nothing extra
to include correctly — an explicit tradeoff, not an oversight.

## Batch window tradeoff: bandwidth/throughput vs. added latency

Bandwidth savings and throughput are governed by delta compression and message volume — **not**
by batch window size (batching changes *when* Redis/Postgres/broadcasts happen, not *what* gets
sent). Latency is governed by the batch window. Three real runs, same load shape (100 simulated
drivers, 10s, sending every 1000ms), only `WS_BATCH_WINDOW_MS` changed between runs:

| Batch window | Avg added latency | p95 added latency | p99 added latency | Bandwidth savings |
| -----------: | -----------------: | -----------------: | -----------------: | -----------------: |
| 200ms        | 142ms              | 171ms              | 172ms              | 25.3%              |
| 300ms        | 204ms              | 303ms              | 303ms              | 25.3%              |
| 500ms        | 542ms              | 662ms              | 663ms              | 25.3%              |

("Added latency" = time from a driver's send to the corresponding broadcast reaching a
subscriber; on localhost this is dominated by the batch window itself, not network/processing
time.)

**The tradeoff, in numbers**: bandwidth savings is flat across all three windows (as expected —
it's a function of the delta-compression scheme, not the flush cadence), while p95 latency more
than triples from 200ms to 500ms. There's no bandwidth reason to pick a larger window — the only
reason to widen it is to further reduce Redis/Postgres round-trip *count* at larger fleet sizes
(fewer, bigger batches). **300ms was chosen as the default**: comfortably real-time for a moving
vehicle (a rider's map updates roughly 3-4x/second, well within perceptible smoothness) while
still consolidating a meaningful number of updates per flush at fleet scale. 200ms trades a
little Redis/Postgres consolidation for tighter latency; 500ms is the point where latency starts
being the more noticeable cost without buying more bandwidth savings, which is part of why
`MAX_BATCH_WINDOW_MS` is capped at 1000ms.

## First-update-ever: tested, not assumed

Two related edge cases, both explicitly tested rather than incidentally passing:

- `test/ws-delta-compression.test.ts`, "the first-ever message for a subscriber is a full
  payload, never a delta" — direct unit test of `encodeLocationMessage(null, ...)`.
- `test/ws-delta-compression.test.ts`, "a subscriber's first update is full even if the driver
  has already broadcast to others" — integration test proving the per-subscriber (not
  per-driver) design: a late-joining subscriber still gets a full payload first, verified via the
  real WS protocol end-to-end.

## Verifying it yourself

```
cd core
npm test                       # unit + integration coverage for batching and delta compression
npm run load-test:fleet        # the 1,000-driver load script (needs a running server)
```

Before running the full 1,000-driver scale, raise the open-file-descriptor limit:
`ulimit -n 4096`. Override scale/duration/window via env vars — see the script's header comment
for the full list. To reproduce the window-size comparison table, restart the server with a
different `WS_BATCH_WINDOW_MS` between runs (`DRIVER_COUNT=100 DURATION_MS=10000
npm run load-test:fleet` at each).

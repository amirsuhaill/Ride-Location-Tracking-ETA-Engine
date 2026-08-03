# Real-Time Location Streaming via WebSockets (Phase 4)

Built on `@fastify/websocket` (a thin Fastify wrapper around `ws`), registered in `src/server.ts`.
Two connection types, two routes:

- **`GET /ws/driver?driverId=<uuid>`** — a driver's app streams its own location.
- **`GET /ws/subscribe`** — a rider/dispatcher subscribes to one driver's or trip's location
  stream.

Implementation lives in `core/src/ws/`: `driver-connections.ts`, `subscriptions.ts`,
`heartbeat.ts`, `messages.ts` (zod schemas), `runtime-config.ts`, `util.ts`. Routes:
`src/routes/ws.ts`.

## Driver connections

### Identifying the driver

`?driverId=<uuid>` is validated in a `preValidation` hook — **before** the WS upgrade completes
— against two checks: syntactically a UUID, and an existing driver in Postgres. Either failure
fails the upgrade itself with a real HTTP status (400/404), rather than accepting the connection
and immediately closing it.

This is deliberately *identification*, not *authentication* — there's no signed token, no proof
the caller actually is that driver. That's an explicit, documented simplification for this phase
("even a simple token/id for now" per the brief): a production version would validate a signed
token (JWT or similar) issued to that specific driver at login, checked in the same
`preValidation` hook, in addition to the existence check that's already there.

### Message protocol

Driver → server, one shape, no envelope (this channel only ever carries one message type):

```json
{ "lat": 37.7749, "lng": -122.4194, "timestamp": 1706900000000 }
```

Validated (`src/ws/messages.ts`, zod): `lat`/`lng` must be finite numbers in range (this is what
rejects `NaN` — `.finite()` rejects `NaN`/`Infinity` explicitly, on top of the plain range check),
`timestamp` must be a finite epoch-ms number within `WS_TIMESTAMP_TOLERANCE_MS` (default 5
minutes) of server time — this is what rejects "far in the future/past" without hardcoding an
exact bound that would need constant tuning as latency assumptions change.

Server → driver: `{"type":"connected","driverId":...}` on connect, `{"type":"error","message":...}`
if a message fails to parse or validate.

### Malformed payloads don't crash anything

Every step of message handling — `JSON.parse`, zod validation, the processing call — happens
inside handlers that catch their own failures and respond with an `error` message on that one
socket. Verified directly: `test/ws-driver.test.ts` sends invalid JSON, out-of-range coordinates,
a `NaN`-shaped payload (which serializes to `lat: null` on the wire — see below), a raw literal
`NaN` token, and a far-future timestamp, and asserts in every case that (a) the sending
connection gets a clear error and stays open, and (b) a second, unrelated driver connection keeps
working normally in the same test.

**A note on testing `NaN` specifically**: `JSON.stringify({ lat: NaN })` produces `{"lat":null}`
in real JavaScript — `NaN` cannot survive real JSON serialization from a well-behaved client. So
there are two distinct tests: one sending `lat: null` (what a real buggy client's `NaN` actually
looks like on the wire, rejected by the schema's type check), and one sending hand-crafted raw
text containing a literal `NaN` token (which fails at the `JSON.parse` stage instead — also
handled, also doesn't crash anything).

## Throttling: coalesce (last-value-wins), not drop

Requirement: at most one *released* location update per driver per `WS_DRIVER_THROTTLE_MS`
(default 1000ms). Implementation (`src/ws/driver-connections.ts`): per-driver throttle state
tracks `lastProcessedAt` and a single `pending` slot.

- If the throttle window has elapsed since the last released update: release it immediately.
- Otherwise: **overwrite** `pending` with this update (previous pending value is discarded) and,
  if one isn't already scheduled, start a timer for the remainder of the window that releases
  whatever is in `pending` when it fires.

This means: within any throttle window, at most one update is ever released, and it's always
the *most recently received* one — never the first. "Released" feeds into the fleet-wide batch
flush (Phase 5, `docs/ws-batching-and-compression.md`) rather than hitting Redis/Postgres/
broadcast immediately — the two mechanisms are layered, not the same thing.

**Why coalesce instead of drop:** location is a "current state" stream, not an event log — only
the latest position is ever useful for nearby search, ETA, or the rider's map. A naive "drop
anything that arrives before the window elapses, process the next one that happens to land after
it" strategy has a subtle freshness bug: if updates keep arriving in a tight burst, the "next one
after the window" is arbitrary — it could be arbitrarily close to the window boundary while a
much more recent position was dropped moments earlier. Coalescing guarantees the last known
position before each flush is always the one applied, at the same processing/broadcast rate as
dropping would give — same backpressure protection, strictly better freshness.

**Verified two ways:**
- `test/ws-driver.test.ts` ("throttles and coalesces..."): sends 7 updates over ~560ms at a
  configured 300ms throttle window, asserts the processed count is small (never close to 7) and
  that the *last* broadcast reflects the *last* sent value.
- `core/scripts/ws-throttle-client.ts` — a standalone script (not part of `npm test`) run against
  a real live server: sends a location update every 200ms for 5 seconds (25 raw sends) and counts
  actual broadcasts received by a subscriber. Real captured run:

  ```
  Raw sends: 25
  Broadcasts received: 6
  Expected (approx, throttle=1000ms): ~6
  Decoded final lat: 25 (should equal last sent lat: 25, proving coalesce/last-value-wins)

  PASS: server forwarded throttled updates at the configured rate.
  ```

  Run it yourself against a running server: `npm run ws:throttle-check` (or
  `make up` in another terminal first).

## Reconnect: replace, don't duplicate

At most one live connection per `driverId` (`connections: Map<driverId, DriverConnection>`). If
a new connection arrives for a `driverId` that already has one registered, the old socket is
closed (code `4000`, "replaced by newer connection") and its throttle timer/heartbeat tracking
are cleared *before* the new connection is registered — so a reconnect (app restart, network
blip) never leaves two sockets both claiming to represent the same driver, and never leaks the
old throttle timer. Verified in `test/ws-driver.test.ts`: connecting twice for the same driverId
leaves exactly one registered connection, and the new one is fully functional.

## Abrupt disconnect: reuses Phase 3's staleness mechanism, doesn't duplicate it

**Deliberate design choice:** a WS `close` event (clean or not) only cleans up *in-memory*
connection/throttle/heartbeat state. It does **not** immediately flip the driver's status to
`offline` in Postgres/Redis.

Why: a dropped connection is not proof a driver has actually gone offline — phones lose signal
for a few seconds constantly, and immediately marking `offline` on every disconnect would fight
directly with reconnect support (a driver reconnecting a second later would need to flip back to
`online`, causing status "flapping" visible to riders/dispatchers watching that driver).

Instead, this reuses the exact staleness + reconciliation mechanism built in Phase 3
(`docs/redis-geo.md`): a driver's Redis entry has a `lastUpdatedAtMs`, and if no location update
(via `/ws/driver` or `PATCH /drivers/:id/location`) refreshes it within `DRIVER_STALE_MS`
(default 90s), `/drivers/nearby` stops surfacing them immediately (query-time freshness check),
and the background `reconcileStaleDrivers` job (running every `RECONCILE_INTERVAL_MS`, default
30s) evicts them from Redis and corrects Postgres to `offline` shortly after.

**The bounded, documented time window**: worst case, a driver who disconnects without sending
"offline" is marked stale/offline within `DRIVER_STALE_MS + RECONCILE_INTERVAL_MS` ≈ **120
seconds** (90s + 30s) of their last successful location update. This is one definition of
"stale" shared by the REST, Redis, and WebSocket layers, rather than three different timeout
concepts that could disagree with each other.

## Heartbeat (ping/pong)

`src/ws/heartbeat.ts` — shared by both driver and subscriber connections. Every tracked
connection gets `isAlive = true`; each sweep (every `WS_HEARTBEAT_INTERVAL_MS`, default 30s):
if a connection's `isAlive` is still `false` from the *previous* sweep, it's terminated and
untracked (a `.terminate()` call — this fires that socket's own `close` handler, which runs the
normal driver/subscriber cleanup path, so heartbeat death funnels into the same cleanup code as
any other disconnect, not a separate path); otherwise it's flipped to `false` and pinged again —
a `pong` response flips it back to `true` before the next sweep.

This is what catches connections a normal `close` event would never fire for — the peer's
machine loses power, or the network drops without a TCP FIN — which would otherwise accumulate
forever as zombie entries in the connection registries.

**Testing note:** a real "silent death, no FIN ever sent" is hard to simulate meaningfully on one
machine (any client-side `.close()`/`.terminate()` call, even an abrupt one, still delivers a
real close event to the server). So `test/ws-heartbeat.test.ts` tests the sweep *logic* directly
and deterministically instead of waiting on real network timing: it grabs the exact server-side
socket for a connected driver, marks it dead (as if it missed its last pong), calls the sweep
function directly, and asserts the connection is untracked and its registry entry is cleaned up —
and, separately, that a live connection survives a sweep untouched.

## Subscriptions

### Protocol

Rider/dispatcher → server, JSON messages with a `type` discriminator:

```json
{ "type": "subscribe", "driverId": "..." }
{ "type": "subscribe", "tripId": "..." }
{ "type": "unsubscribe" }
```

Server → client: `{"type":"connected"}` on connect, `{"type":"subscribed", driverId or tripId+driverId}`
on success, `{"type":"unsubscribed", reason}` on unsubscribe (`"client_requested"` or
`"trip_completed"`/`"trip_cancelled"`), `{"type":"error", message}` on anything invalid.

Location broadcasts are **batched and delta-compressed** (Phase 5, see
`docs/ws-batching-and-compression.md` for the full design and measured bandwidth/latency
numbers): a subscriber's first update for a given driver is
`{"type":"location", driverId, lat, lng, timestamp, status}`; subsequent updates are
`{"type":"delta", driverId, dLat, dLng, timestamp, status?}` — quantized position deltas with
`status` present only when it changed since the last message sent to that subscriber.

**Scope simplification**: each subscriber socket holds exactly one subscription at a time —
subscribing again on the same socket replaces the previous one. A client that wants to watch
multiple drivers/trips at once opens multiple WebSocket connections. This keeps the
subscribe/unsubscribe/broadcast bookkeeping a simple 1:1 socket-to-subscription mapping; nothing
in the current requirements calls for multiplexing several subscriptions over one socket.

### Subscribing by driver vs. by trip

- By `driverId`: validated to exist, then registered directly for that driver's broadcasts.
- By `tripId`: the trip must exist and not already be `completed`/`cancelled` (rejected with a
  clear error otherwise). Its **currently assigned driver is resolved once, at subscribe time**
  (`trip.driverId`, possibly `null` if unmatched — that's accepted, not an error; the
  subscription just won't receive anything until re-subscribed once a driver is assigned). This
  is a scoped-to-Phase-4 simplification: re-resolving a trip's driver if it's reassigned mid-trip
  is Phase 6+ (matching) territory, since trips can't even be matched to a driver yet in this
  build. Broadcasting stays an O(1) map lookup rather than a Postgres query per location update.

### Unsubscribing cleanly — no leaked subscriptions

Three ways a subscription ends, all converging on the same `detach()` cleanup (removes the
subscriber from every index it's registered under — by-driver, by-trip, and the reverse
by-socket lookup used for cleanup itself):

1. **Client sends `{"type":"unsubscribe"}`.**
2. **Socket closes** (any reason) — the `close` handler unsubscribes automatically.
3. **The trip ends.** `notifyTripStatusChanged(tripId, "completed" | "cancelled")` — exported
   from `src/ws/subscriptions.ts` — finds every subscriber on that trip, sends them a clean
   `unsubscribed` message, and detaches them from both indices.

**On (3):** the real caller for this is whatever marks a trip `completed`/`cancelled` — Phase 6's
matching/trip-lifecycle flow, which doesn't exist yet in this build (Phase 2 only has
`POST`/`GET /trips`, no status-changing endpoint). So the mechanism is built and fully exercised
now — `test/ws-subscribe.test.ts` calls `notifyTripStatusChanged` directly (the same call Phase
6's code will make once it exists) and asserts the subscriber gets the clean unsubscribe message
and that **both** the trip-keyed and driver-keyed indices end up empty (proving no leak in
either, not just the obvious one) — while the actual *trigger* (an endpoint that transitions a
trip to `completed`) is intentionally left for the phase that owns trip lifecycle.

## Verifying it yourself

```
cd core
npm test                    # 21 WS-specific tests among the full suite
npm run ws:throttle-check   # standalone script, needs a running server (npm run dev / make up)
```

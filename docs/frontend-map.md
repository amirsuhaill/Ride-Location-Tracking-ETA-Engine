# Frontend: Map Foundation & Live Driver Markers (Frontend Phase 1)

A read-only fleet map on the Dispatcher route: every online driver within the current viewport
(via `GET /drivers/nearby`, refetched on pan/zoom), and one real live-tracked driver via a genuine
`/ws/subscribe` connection with client-side delta decoding, reconnect/backoff, and auto-resubscribe.

## SF bounding box, reused exactly

`src/constants.ts`'s `SF_BBOX` is copied verbatim from `core/scripts/seed.ts` /
`core/scripts/lib/trip-simulator.ts` (`minLat: 37.708, maxLat: 37.812, minLng: -122.514, maxLng:
-122.386`), and `MapContainer`'s `bounds` prop uses it directly (`fitBounds` under the hood) —
an exact fit to where the backend's own seeded/simulated data actually lives, not an eyeballed
center+zoom pair.

## The client-side delta codec

`src/ws/deltaCodec.ts` mirrors `core/src/ws/delta-compression.ts`'s decode side and wire format
exactly (`QUANTIZATION_STEP_DEGREES = 1e-5`, `decode = lastKnown + dLat/dLng * step`, status
carried forward when a delta omits it) — the same cross-boundary mirroring convention this project
already uses for `ml-service/app/ml/constants.ts` mirroring core's TS constants into Python,
documented there as a real, accepted cost of the split. Here the "boundary" is a separate package
rather than a separate language, but the same tradeoff applies: this file needs a matching update
if core's wire format ever changes.

**Tests** (`src/ws/deltaCodec.test.ts`, 5 tests): a full `"location"` message decodes to an exact
position; a single delta round-trips within the documented ±half-quantization-step per axis and
the combined ~0.71m radial bound (re-derived from first principles in the test, not copied as a
magic number); status carries forward across a delta that omits it; **a chain of 15 real delta
messages does not accumulate error** beyond the single-hop bound (mirrors
`core/test/ws-delta-compression.test.ts`'s own "50 messages, no accumulation" test); and **the
first-message-must-be-full edge case** — decoding a delta with no prior state throws, matching the
real server's own invariant (a subscriber's first-ever message is always a full payload, never a
delta with nothing to delta against).

## Reconnect: `SubscriberSocket` (`src/ws/subscriberSocket.ts`)

Backoff schedule: **500ms initial, ×2 multiplier, capped at 10s** (500ms → 1s → 2s → 4s → 8s →
10s → 10s → …) — short enough that a transient blip (core restarting) recovers quickly, capped so
a genuinely down backend isn't hammered, and never climbs unboundedly. Resubscribing on
reconnect needs no separate "remember what we wanted" logic: `subscribeToDriver()` stores the
request and the `open` handler re-sends it on every successful (re)connection, whichever attempt
that turns out to be.

**Heartbeat ping/pong needs zero application code** — a real, verified, non-obvious point, not an
oversight: the server's `socket.ping()` (`core/src/ws/heartbeat.ts`) is a native WebSocket
protocol control frame (RFC 6455). A browser's `WebSocket` implementation answers it with a pong
at the network-stack level; control frames never surface as `'message'` events in JavaScript at
all. (A Node.js `ws` client can need manual ping/pong handling in some configurations — a browser
never does.) The only heartbeat-adjacent thing this client needs is exactly what it already has:
noticing the connection dropped and reconnecting.

**Explicit teardown**: `close()` cancels any pending reconnect timer and closes the live socket.
`useDriverTracking` (`src/hooks/useDriverTracking.ts`) calls it from a `useEffect` cleanup —
running on unmount *and* whenever the tracked `driverId` changes — so a component never relies on
garbage collection to stop an old connection.

## A real discovery: `PATCH /drivers/:id/location` never triggers a broadcast

The acceptance criteria's suggested fallback for testing live movement — "a single manual `PATCH
/drivers/:id/location` loop" — **does not actually work**, verified directly before relying on it:

```
[subscriber received] { type: 'connected' }
[subscriber received] { type: 'subscribed', driverId: '...' }
--- sending a REST PATCH location update ---
messages received after PATCH: 2                              # unchanged — no broadcast
--- connecting as the driver over /ws/driver and sending a location update ---
[subscriber received] { type: 'location', driverId: '...', lat: 37.795, lng: -122.425, ... }
messages received after /ws/driver update: 3                  # the real ingestion path
```

`broadcastDriverLocation` (`core/src/ws/subscriptions.ts`) is only ever called from
`ws/location-batch.ts#flushBatch` — the fleet-wide WebSocket ingestion path (Phase 5). `PATCH
/drivers/:id/location` (`drivers.service.ts#updateDriverLocation`) writes Postgres and Redis
directly for the plain-HTTP demo/test use case, but never touches the subscriber broadcast path at
all. **Live map movement requires a real `/ws/driver` connection** — this doc's own verification
below uses one, not the REST endpoint.

## Another real discovery: the reconciliation job actually reconciles

Mid-development, `/drivers/nearby` started returning an empty list for drivers that had shown up
moments earlier — not a bug. `docs/redis-geo.md`'s background reconciliation job
(`RECONCILE_INTERVAL_MS`, default 30s) had correctly detected their Redis entries had gone stale
past `DRIVER_STALE_MS` (default 90s, from idle time between manual test steps) and flipped them
`offline` in both Redis and Postgres, exactly as documented — a real, working feature catching a
side effect of slow manual testing, not something to route around. The verification script below
explicitly re-asserts `online` status and pings a fresh location for its demo drivers on a 20s
keep-alive, rather than assuming they stay reachable indefinitely.

## Verified live (real browser, real WebSocket connections, real Docker containers)

Every check below ran in one continuous Playwright + `ws` script against the real `core` (Docker),
not mocked:

```
=== 1. Load dispatcher view, confirm real markers render for real seeded drivers ===
markers rendered: 5

=== 2. Click the specific known driver's marker to start live tracking ===
badge once connected: "Tracking 5acf2f7c… — live 37.77600, -122.41840"

=== 3. Real movement: open a genuine /ws/driver connection and send real updates ===
badge before movement: "Tracking 5acf2f7c… — live 37.77600, -122.41840"
badge after movement: lat=37.794, lng=-122.422 (real sent: {"lat":37.794,"lng":-122.422})
position error vs real sent coordinate: 0.000m (bound: ~0.71m)

=== 4. Kill and restart core mid-session: reconnecting -> real recovery, timed ===
stopping core...
badge while core is down: "Tracking 5acf2f7c… — reconnecting… 37.79400, -122.42200"
starting core...
recovered after 1374ms: "Tracking 5acf2f7c… — live 37.79400, -122.42200"

=== 5. Navigate away and back, re-subscribing each time: no accumulating leak ===
subscriber connections before this section: 1
subscriber connections after 3 subscribe->navigate-away->navigate-back cycles: 1

ALL PHASE 1 CHECKS PASSED
```

Notes on reading these numbers honestly:

- **Position error of exactly 0.000m** isn't a fabricated "too clean" number — the test's three
  movement points (`37.79`, `37.792`, `37.794`) are each exactly `200 × 1e-5` apart, an exact
  multiple of the quantization step, so this specific sequence rounds perfectly. The codec's own
  unit tests (above) use non-round-number movements specifically to exercise real, non-zero
  quantization error and confirm it stays within the documented ~0.71m bound.
- **1,374ms recovery** is real elapsed wall-clock time from `docker compose start core` to the
  badge reading "live" again — far faster than the 500ms-to-10s reconnect backoff schedule's later
  steps because this was caught on the very first (500ms-delayed) retry attempt, itself gated by
  however long `core` actually took to accept new WebSocket connections after restarting.
- **Subscriber connection count** (`GET /internal/metrics` → `ws.subscriberConnections`) is core's
  own real, live counter — checked instead of manually reading Chrome DevTools' WS panel, since
  it's the same signal, machine-verifiable, and not dependent on a human remembering to look.

## Verifying it yourself

```
make up                                    # postgres, redis, core, ml-service (repo root)
cd core && npm run seed                    # ~20 drivers with locations in Postgres
# give at least one driver a live Redis geo entry (seed.ts only writes Postgres):
curl -X PATCH http://localhost:3000/drivers/<id>/status -d '{"status":"online"}'
curl -X PATCH http://localhost:3000/drivers/<id>/location -d '{"lat":37.7749,"lng":-122.4194}'

cd ../frontend
npm run dev                                # http://localhost:5173/dispatcher
npm test                                   # includes src/ws/deltaCodec.test.ts (5 tests)
npm run typecheck
npm run lint
npm run build
```

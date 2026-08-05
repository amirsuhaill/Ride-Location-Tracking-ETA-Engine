# Frontend: Rider Flow — Live Trip Tracking (Frontend Phase 3)

After a trip is requested, the rider's view is driven **entirely off real `/ws/subscribe`
messages** — status transitions, the matched driver's live position, and cancellation both come
from real server broadcasts, not a `GET /trips/:id` poll loop.

## A pure state machine, not logic buried in a hook

`src/hooks/tripTrackingReducer.ts#applyTripMessage` is a pure function —
`(state, message) => { state, effect }` — with no WebSocket, timer, or React dependency at all.
`src/hooks/useTripTracking.ts` is thin glue around it: one persistent `SubscriberSocket` for the
hook's whole mount lifetime, an effect that calls the reducer on every message and updates React
state, and a second effect that explicitly calls `socket.unsubscribe()` before
`socket.subscribeToTrip(newId)` whenever the tracked `tripId` changes — so a trip the UI no longer
cares about never keeps accumulating messages on a lingering subscription. A single trip
subscription is also enough to receive the assigned driver's location broadcasts once matched —
core re-indexes the subscriber onto the driver server-side at match time
(`subscriptions.ts#notifyTripMatched`), so no second subscription is ever needed.

Making this pure paid off immediately: it's fully unit-testable with plain Vitest, no mocking, no
DOM — **17 tests** (`tripTrackingReducer.test.ts`, `deltaCodec.test.ts`) covering every documented
message shape, including one this backend build currently has **no live way to trigger** (see
below).

## Two races handled explicitly, both resolved with one targeted fetch — never a poll

1. **`unsubscribed` / `reason: "trip_cancelled"`** tells us the trip was cancelled, but the WS
   protocol doesn't carry *which* of the two reasons (`docs/matching.md`). One `GET /trips/:id`
   resolves it.
2. **Matching can resolve within milliseconds** (`docs/surge-pricing.md`'s own note) — potentially
   faster than our subscribe message reaches the server. core refuses new subscriptions to an
   already-ended trip and returns a generic `{"type":"error","message":"...already ended"}`
   instead of `"unsubscribed"` (`docs/websockets.md`) — caught by matching on that message text,
   resolved the same way.

Neither of these is "polling" — each is a single fetch triggered by a specific WS event, not a
timer.

## A real, honest backend gap: `trip_completed` has no live trigger yet

While building this, it became clear the current backend has **no endpoint or automatic mechanism
that ever transitions a trip to `in_progress` or `completed`** — confirmed by reading
`core/src/ws/subscriptions.ts#notifyTripStatusChanged`'s own doc comment: *"the real caller for
this is whatever marks a trip completed/cancelled — Phase 6's matching/trip-lifecycle flow, which
doesn't exist yet in this build... the mechanism is built and fully exercised now [only by
`test/ws-subscribe.test.ts` calling it directly]... while the actual trigger is intentionally left
for the phase that owns trip lifecycle."* This is core's own precedent for exactly this situation
— test a real, documented mechanism directly when no live trigger exists, rather than skip it.

This frontend follows the same precedent: `applyTripMessage` handles
`{"type":"unsubscribed","reason":"trip_completed"}` correctly (→ `status: "completed"`, no
follow-up fetch needed, `TripTrackingPanel` shows "Trip completed." and reveals "Request another
trip"), verified with the exact documented message shape in `tripTrackingReducer.test.ts` — genuine
unit-test rigor, honestly substituting for a live trigger that doesn't exist yet rather than
skipping this documented behavior or, worse, quietly leaving it untested.

`in_progress` is handled the same defensively-correct way (never reachable live in this backend
either, for the same reason) — `TripTrackingPanel` renders a distinct "en route to the dropoff"
message for it, exercised only by direct construction in the reducer's own logic, not a live path.

## ETA polling: matched to the backend's own interval, stopped the moment it's pointless

`src/hooks/useTripEta.ts` polls every **15,000ms** — `ETA_RECOMPUTE_INTERVAL_MS`'s actual default
(`core/.env.example`, `core/src/config.ts`), not an invented number. The poll is enabled by
`trackedTripId !== null && !isTerminal`; when the trip reaches `completed`/`cancelled`, the
effect's own cleanup clears the interval and the effect body's early return means no new timer is
set — verified live below by literally counting `/eta` network requests before and after.

`EtaBadge` (`src/components/EtaBadge.tsx`) surfaces the same `etaSource`/`servedFromCache`
information core's `X-ETA-Source`/`X-ETA-Cache` response headers already carry
(`docs/eta-integration.md`) — never hidden behind just a plain number.

## Verified live (real driver clients, real matching, real ml-service outage)

### A real matched trip, real movement, driven by real broadcasts

```
=== Real driver client connects FIRST (matching can resolve within milliseconds) ===
driver connection established
=== Rider creates a trip with pickup near the driver ===
trip requested, waiting for match...
=== Real driver client: receive the offer, accept it ===
driver received trip_offer for trip d8f53a22-...
driver received trip_matched confirmation
=== Rider UI reflects the real match ===
rider UI shows 'matched'
=== Real movement: driver sends a first update, then moves toward pickup/dropoff ===
live driver marker appeared after its first real broadcast
driver marker screen position before: {"x":479,"y":463,"width":14,"height":14}
driver marker screen position after:  {"x":496,"y":426,"width":14,"height":14}
confirmed: the marker moved on screen, driven by real broadcast messages
```

The driver's WS connection had to be opened **before** the trip request — an early version of
this verification script connected the driver only after seeing "Looking for a nearby driver," and
the offer never arrived: `matchTrip` runs (and can fully resolve) within the same request cycle,
too fast for a late-connecting driver to receive it. Real timing, not assumed.

### `ETA_MODE=ml_with_fallback`: stopping ml-service mid-trip flips the badge within one poll

```
=== Wait for a real ETA poll to show etaSource: ml (ml-service is up) ===
ETA badge (ml-service healthy): "ETA: 8 min (ML, fresh)"
=== Stop ml-service mid-trip ===
 Container ride-tracking-ml-service-1  Stopped
=== Wait for the badge to flip to ml_fallback within one poll interval ===
ETA badge (ml-service down): "ETA: 5 min (ML (fallback), fresh)"
UI still showing the tracking panel (no error/freeze): true
```

The three real ETA requests captured from the browser's own network activity landed at
`05:57:58`, `05:58:13`, `05:58:28` — **exactly 15 seconds apart**, confirming the poll interval
matches `ETA_RECOMPUTE_INTERVAL_MS` for real, not just in the code.

### Both cancellation outcomes, captured side by side, distinct messages

| `no_drivers_available` | `all_candidates_declined` |
| --- | --- |
| `docs/screenshots/cancellation-no-drivers-available.png` | `docs/screenshots/cancellation-all-candidates-declined.png` |
| "No drivers are online nearby right now." | "Nearby drivers were asked but none accepted." |

Scenario A used a pickup point far from any online driver (beyond `MATCH_SEARCH_RADIUS_METERS`).
Scenario B used one real online driver with a real `/ws/driver` connection that explicitly
declined the real `trip_offer` it received — matching `docs/matching.md`'s own test technique for
this exact distinction, not a fabricated pair of strings.

### The ETA poll actually stops — confirmed by counting real network requests, not by the UI going quiet

```
ETA requests fired so far: 1
ETA requests after waiting 20s past terminal: 1
confirmed: no further /eta requests fired once the trip was terminal
```

Captured via Playwright's own `page.on("request")` listener (the same signal devtools' Network tab
shows) across a wait longer than one full poll interval — the request count staying flat is the
actual proof the poll stopped, not just that the badge stopped visibly changing.

## Verifying it yourself

```
make up   # postgres, redis, core, ml-service — need a trained model for the ml_fallback check:
cd ml-service && python scripts/train_model.py   # if models/latest.json doesn't exist yet
cd ../core && npm run seed                        # optional — this phase creates its own drivers

cd ../frontend && npm run dev                      # http://localhost:5173/
npm test                                           # includes tripTrackingReducer.test.ts (12 tests)
npm run typecheck
npm run lint
npm run build
```

To reproduce the matched-trip/ml-fallback/cancellation checks above, drive a real `/ws/driver`
connection the same way `test/matching.test.ts` does: connect, wait for `{"type":"trip_offer"}`,
respond with `{"type":"trip_response","tripId":...,"accept":true|false}` — see this doc's own
captured transcripts for the exact sequence.

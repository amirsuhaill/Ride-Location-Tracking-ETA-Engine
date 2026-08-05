# Frontend: Driver Flow — Trip Offers (Frontend Phase 5)

Extends the driver dashboard's existing `/ws/driver` connection (no second socket) to receive
`trip_offer` messages, render a real accept/decline countdown driven entirely by the offer's own
server-sent `offerTimeoutMs`, and transition into "matched" once `trip_matched` arrives.

## The state machine: `driverOfferReducer.ts`

A pure `(state, event) => {state, effect}` function (same shape as Phase 3's
`tripTrackingReducer.ts`), independently unit-tested with no WebSocket, timer, or React dependency
at all — 12 tests in `driverOfferReducer.test.ts`.

```
idle --trip_offer--> offered --accept--> responding --trip_matched--> matched
  ^                     |                    |
  |                     +--decline--> declined
  |                     |
  |                     +--deadline_elapsed--> expired (reason: "no_response")
  |
  +----------------------------------------- (never re-entered once matched)

responding --grace_elapsed--> expired (reason: "too_late")
```

### Why a grace period exists at all: the backend gives zero feedback for a late response

Reading `core/src/ws/trip-offers.ts` and `core/src/ws/driver-connections.ts` while designing this
state machine surfaced a real, deliberate-looking gap: `handleDriverResponse` returns `false` when
there's no pending offer for a `tripId` (already resolved or timed out server-side) — but the
message handler that calls it (`driver-connections.ts`) **ignores that return value entirely**. A
`trip_response` that arrives even one moment too late gets no error, no rejection, nothing. The
only observable signal the client ever has for "did my accept actually land" is whether
`trip_matched` shows up at all.

That's why `accept` doesn't jump straight to a "matched" or "success" state — it moves to
`responding`, and only `trip_matched` (or the grace timer expiring first) resolves it one way or
the other. `CONFIRMATION_GRACE_MS = 2000` covers real round-trip latency for the response to reach
the server and any resulting `trip_matched` to come back, without leaving the driver staring at
"Waiting for confirmation…" forever if the response genuinely lost the race.

### Two honest terminal states, never conflated

`TripOfferPanel.tsx` renders `reason: "no_response"` ("You didn't respond in time — this offer
expired.") distinctly from `reason: "too_late"` ("Your response arrived too late — this trip was
already given to another driver.") — the first is silence, the second is an accept that the server
no longer cared about. Neither is ever rendered as `matched`.

### Avoiding a real React StrictMode bug, twice

The natural first implementation of the connecting hook called `DriverSocket#sendTripResponse`
(and, in Phase 3's `useTripTracking.ts`, `getTrip()`) from inside a `setState(prev => ...)`
updater. That's unsafe: StrictMode double-invokes updater functions in development specifically to
catch impure ones, so a real accept/decline would have been sent to the server **twice**. Fixed in
both hooks via the same pattern — track current state in a ref, compute the transition against the
ref, call `setState` with a plain resulting value (never an updater function), and only then run
the side effect, entirely outside React's state-update machinery. `useTripTracking.ts` had the
identical latent bug from Phase 3 and was fixed the same way here; all 36 existing frontend tests
still passed unchanged afterward, confirming no behavior change, just correctness of the pattern.

## Two real backend gaps found via this phase's own live verification

Both were found by actually running the acceptance criteria against real Docker containers, not by
reading the code and guessing — and both were fixed at the source, not routed around client-side,
matching this project's standing precedent (e.g. Phase 4's CORS fix, `docs/frontend-driver-location.md`).

### 1. `notifyTripStatusChanged` had no production caller for the cancellation path

The first live run of the offer-timeout scenario hung: the driver-side countdown expired exactly on
time, but the rider's UI never learned the trip was cancelled. `notifyTripStatusChanged`
(`core/src/ws/subscriptions.ts`) had existed and been directly unit-tested since the websockets
phase — but grepping production code turned up no caller for it on the trip-cancellation path
(`matching.service.ts#resolveUnmatched`). A subscriber whose `subscribe` message arrives *before* a
slow cancellation resolves (the normal case for a full offer-timeout cycle) had no way to ever find
out. Earlier phases' live checks of cancellation had happened to race a *different* path instead —
`routes/ws.ts`'s subscribe-time check for an already-ended trip — so this gap stayed invisible until
a cancellation that takes real wall-clock time (a genuine 10-second offer timeout) was actually run
end to end.

**Fixed** in `core/src/services/matching.service.ts#resolveUnmatched`: calls
`notifyTripStatusChanged(tripId, "cancelled")` on the success path. Regression coverage added to the
existing `test/matching.test.ts` "no drivers available" case (asserts the subscriber actually
receives `{"type":"unsubscribed","reason":"trip_cancelled"}`).

### 2. A freshly-matched driver stayed falsely visible in the live nearby search

While building the two-tab double-booking demonstration, a direct post-match check against
`GET /drivers/nearby` unexpectedly still returned the driver that had just been matched. Reading
`core/src/repositories/trips.repository.ts#tryFinalizeMatch` explained why: it writes the driver's
new `busy` status straight to Postgres via a raw SQL `UPDATE` inside its transaction, and never
touches Redis's separate live geo index (`drivers:geo` / `driver:{id}:state`) at all. The *only*
place that mirrors a status change into Redis is `drivers.service.ts#updateDriverStatus`
(`updateDriverStatusInRedis`) — the driver-initiated online/offline/busy toggle route — which the
match-finalize path never goes through.

In practice this self-heals the moment the driver's next routine location ping lands (that path
does correctly pass the driver's current Postgres status into the Redis write), but until then a
driver who was just matched to one trip remains falsely searchable and offerable for a *different*
trip. The Redis lock (`driver-lock.repository.ts`) and the guarded Postgres transaction
(`tryFinalizeMatch`'s own `WHERE status = 'online'`) both still prevent an actual double-booking —
this gap is narrower than that: a busy driver receiving a stray `trip_offer` they were never
supposed to see, purely because the cached view hadn't caught up.

**Fixed** in `core/src/services/matching.service.ts#tryOfferToDriver`: calls
`driversGeoRepo.updateDriverStatusInRedis(driverId, "busy")` immediately after `tryFinalizeMatch`
succeeds, closing the window entirely rather than relying on the next ping. Regression coverage
added to `test/matching.test.ts`'s "successful match" case (asserts `searchNearby` excludes the
driver immediately post-match, no ping required).

## Verified live (real browser, real Docker containers, real 10-second `offerTimeoutMs`)

`infra/docker-compose.yml` hardcodes `MATCH_OFFER_TIMEOUT_MS: 10000` (not
`${MATCH_OFFER_TIMEOUT_MS:-10000}`), so a host env var override is silently ignored — confirmed via
`docker exec ride-tracking-core-1 printenv MATCH_OFFER_TIMEOUT_MS`. Rather than edit shipped
production config for testing convenience, every check below used the real 10-second default.

### Criterion 1 — an unanswered offer is a real decline, client and server agreeing

```
=== Setup: one real online driver via a real /ws/driver connection ===
driver e06a3556-2d04-42a2-b933-b056f29f5fa7 online

=== Rider requests a trip near the driver ===

=== Driver receives the real offer with a real countdown, and deliberately does not respond ===
offer received 53ms after the rider's request
offer countdown shows: "10s to respond"
(waiting, NOT clicking accept/decline — letting the real offerTimeoutMs elapse)
client-side offer UI expired 10358ms after receipt

=== Confirm the backend also moved on, at essentially the same real moment ===
rider UI trip id (short): 27a905c4…
rider UI confirms: all_candidates_declined (the backend's own real outcome, matching docs/matching.md)

OFFER TIMEOUT VERIFICATION PASSED
```

### Criterion 2 — two rider tabs, one driver, exactly one match

Two Playwright tabs each pick a pickup/dropoff near the same single online driver and click
"Request ride" via `Promise.all` (submitted within tens of milliseconds of each other). One real
driver tab auto-accepts whichever offer arrives first.

```
=== Setup: ONE real online driver, real /ws/driver connection, auto-accepts any offer ===
driver online, will auto-accept its first offer the instant it appears
driver confirmed discoverable via /drivers/nearby

=== Two riders, two tabs, competing for the SAME single driver ===
both riders have pickup/dropoff set, ready to submit
both trip requests submitted within the same event-loop tick (35ms apart)

=== Waiting for both riders' real outcomes ===
Rider A outcome: matched
Rider B outcome: all_candidates_declined

matched: 1, rejected: 1

=== Confirm via Postgres: the driver is 'busy' on exactly one trip, not two ===
driver findable via /drivers/nearby right now (should be false — busy drivers are excluded): false

DOUBLE-BOOKING PREVENTION VERIFICATION PASSED — exactly one rider matched, real UI proof
```

Run repeatedly (4 consecutive passes after the Redis-mirror fix above and a script timing fix —
see below): always exactly one `matched`, one non-matched outcome (`all_candidates_declined` or
`no_drivers_available`, whichever the real race produced), never two matches and never zero.

Before the Redis-mirror fix, the same script's post-match check reported
`driver findable via /drivers/nearby: true` — the bug described above, caught by this exact
verification step rather than assumed away.

One script-side flake was found and fixed along the way: "Sharing your real location" in the
driver's own UI only reflects client-side geolocation + WS-send readiness, not that the server has
actually geo-indexed the position in Redis yet — occasionally both riders raced ahead of that and
both saw `no_drivers_available`. Fixed by polling the real `/drivers/nearby` endpoint until the
driver is genuinely discoverable before firing either rider's request — a test-harness timing fix,
not a product bug.

### Criterion 3 — accept sent right as the deadline passes shows an honest state, never a false "matched"

The server's own response deadline (`waitForDriverResponse`) starts the instant
`matching.service.ts` calls `sendToDriver` — strictly before the client can possibly receive that
same `trip_offer` frame — so the server's deadline is always at least slightly earlier than the
client's own `deadlineMs` (receipt time + `offerTimeoutMs`). The verification captured the real WS
frame's receipt instant via Playwright's `page.on("websocket")` → `framereceived`, then scheduled an
in-page `setTimeout` (the browser's own clock, not Node's — removing CDP round-trip jitter from the
scheduling itself) to click "Accept" progressively closer to that deadline until landing on the
losing side of the race:

```
margin 30ms before deadline -> matched
margin 15ms before deadline -> matched
margin  8ms before deadline -> matched
margin  4ms before deadline -> matched
margin  2ms before deadline (click actually landed 1ms before the deadline) ->

real trip_offer WS frame received at t=1785915250943, offerTimeoutMs=10000
clicked Accept at t=1785915260942 (9999ms after offer receipt, 1ms before client deadline)
waiting for the driver UI's real, honest resolution (matched vs. too_late)...
RESULT: "too_late" (resolved 2298ms after the click)

RACE VERIFICATION PASSED — an accept sent 2ms before the client's own deadline still arrived at
the server after it had already moved on. The driver UI showed an honest "too late" expiry, never
a false "matched" state.
```

The 2298ms resolution time (click to UI update) lines up almost exactly with
`CONFIRMATION_GRACE_MS = 2000` plus a little round-trip and rendering overhead — confirming the UI
genuinely waited out the full grace window rather than receiving any explicit rejection from the
server (there isn't one), exactly matching the documented zero-feedback behavior above.

## Verifying it yourself

```
make up   # postgres, redis, core
cd frontend && npm run dev   # http://localhost:5173

npm test          # includes driverOfferReducer.test.ts (12 tests)
npm run typecheck
npm run lint
npm run build

cd ../core && npm test   # includes the two new regression assertions — 202 tests
npm run typecheck
npm run lint
```

To reproduce the exact-deadline race, capture a driver page's `trip_offer` WS frame receipt time
via `page.on("websocket")` → `ws.on("framereceived")`, then schedule an in-page `setTimeout`-driven
click a few milliseconds before `receivedAt + offerTimeoutMs`, tightening the margin until it lands
after the server's own deadline. Either outcome (`matched` or `too_late`) is a legitimate, honest
result — the point is that the UI never shows `matched` unless `trip_matched` genuinely arrived.

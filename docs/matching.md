# Trip Matching (Phase 6)

`POST /trips` (Phase 2) creates the trip row and returns immediately; it then fires off
`matchTrip(tripId)` (`src/services/matching.service.ts`) **without awaiting it** — a driver's
accept/decline round trip can legitimately take seconds, which is too slow to hold an HTTP
response open for. The rider learns the outcome via their trip subscription over WebSocket (see
below) or by polling `GET /trips/:id`. `matchTrip` is also directly callable/awaitable, which is
how the test suite drives it deterministically instead of polling.

## The flow

1. Search `drivers.geo.repository.ts#searchNearby` for online drivers within
   `MATCH_SEARCH_RADIUS_METERS` (default 5km), up to `MATCH_MAX_CANDIDATES` (default 5).
2. Score every candidate (see below), highest first.
3. Offer the trip to each candidate **in ranked order**, one at a time: acquire a lock on that
   driver, send them a `trip_offer`, wait up to `MATCH_OFFER_TIMEOUT_MS` for a response. Accept →
   finalize the match and stop. Decline, timeout, unreachable, or lock already held → release the
   lock and move to the next candidate.
4. If every candidate is exhausted (or there were none to begin with), the trip is terminated
   with a distinct, documented reason (see "Two distinct failure outcomes" below).

## Scoring function: weights and rationale

`src/services/matching-score.ts`. Three signals, each normalized to roughly `[0, 1]`, combined
via configurable weights (`src/config.ts` / env vars, not magic numbers in code):

| Signal | Config | Default weight | Normalization |
| --- | --- | --- | --- |
| Distance to pickup | `MATCH_DISTANCE_WEIGHT` | **0.6** | `1 - min(distanceMeters / searchRadiusMeters, 1)` — closer is higher, linear falloff to 0 at the search radius edge. |
| Driver idle time | `MATCH_IDLE_TIME_WEIGHT` | **0.25** | `min(idleTimeMs / MATCH_MAX_IDLE_TIME_MS, 1)` — longer idle is higher, capped at `MATCH_MAX_IDLE_TIME_MS` (default 10 min). |
| Rating / acceptance rate (stubbed) | `MATCH_RATING_WEIGHT` | **0.15** | Already `[0, 1]` — see the stub note below. |

**Rationale** (this is a tunable heuristic, not a claim of optimality — the weights and
normalization shapes below are reasonable starting defaults, not derived from real marketplace
data):

- **Distance dominates** because it directly drives the rider's wait time — the single number
  riders actually feel and complain about. It gets the largest weight for that reason.
- **Idle time is a fairness/utilization signal**, not a quality signal: without it, a driver
  sitting slightly farther away could get skipped for every single trip by a marginally closer
  driver, indefinitely — "driver starvation." A moderate weight lets a long-idle driver
  occasionally win over a slightly-closer one without letting idle time override a genuinely
  large distance gap (it's capped and weighted below distance for exactly that reason).
- **Rating gets the smallest weight** deliberately: it's currently a stub (see below), and even
  once backed by real data, a driver's historical quality shouldn't outweigh the two factors that
  most directly determine THIS trip's actual pickup experience.

### Driver rating: stubbed, structured to swap in later

`src/services/driver-rating.service.ts#getDriverRatingScore(driverId)` returns a deterministic
pseudo-random score in `[0, 1)` derived from hashing the driver's id — deterministic (not
`Math.random()`) so the same driver scores consistently across calls and in tests, without a
real ratings table existing yet. The function is `async` and takes only a `driverId` specifically
so a real implementation (querying an aggregated rating/acceptance-rate table) can replace the
body later without touching `matching-score.ts` or `matching.service.ts` — callers only ever see
"a number between 0 and 1 for this driver."

### Driver idle time: where it comes from

"Idle time" means *time since this driver most recently became available* — not their
cumulative online time, and not reset by routine location pings. Tracked as `onlineSinceMs` in
the driver's Redis state hash (`driver:{id}:state`, alongside the fields from
`docs/redis-geo.md`):

- Set to `now()` whenever a driver's status transitions **to** `online`
  (`drivers.geo.repository.ts#updateDriverStatusInRedis`) — including cycling `busy -> online`
  after finishing a trip, which correctly represents "just became available again."
- **Not** touched by ordinary location pings (`upsertDriverLocation`/`upsertDriverLocationsBatch`)
  — those use `HSETNX` (set-if-missing) purely as a fallback for a driver whose status was
  already `online` before their very first location ping ever arrived. A routine `HSET` here
  would reset every driver's idle clock to ~0 on every ping, defeating the entire signal.

## Preventing double-booking: two independent layers

The requirement is explicit: avoid double-booking "via a DB transaction or Redis lock, not just
an in-memory check." This implementation uses **both**, as genuinely independent layers:

1. **Primary: a Redis distributed lock** (`src/repositories/driver-lock.repository.ts`),
   `SET driver:{id}:lock <tripId> PX <ttl> NX`. This is what actually prevents two concurrent
   `matchTrip` calls from both proceeding to offer the same driver — whichever acquires the lock
   first wins; the other's `SET ... NX` simply fails, and that candidate is skipped immediately
   (no wasted wait). The lock's TTL is `offerTimeoutMs + 5s`, so it always outlives the offer
   window it's protecting — it can't expire out from under a still-in-flight offer, and it can't
   accidentally deadlock a driver forever if a process crashes mid-offer either.
   - **Releasing safely**: a plain `DEL` would be wrong — if this attempt's lock already expired
     and a *different*, newer attempt legitimately acquired the lock for the same driver in the
     meantime, a bare `DEL` would delete someone else's active lock. The release is a Lua
     script doing a compare-and-delete (`GET` == our tripId, then `DEL`) — atomic, and only ever
     removes a lock this exact attempt still owns.
2. **Secondary: a guarded Postgres transaction** (`trips.repository.ts#tryFinalizeMatch`) — the
   actual atomic "point of no return." Both UPDATEs (`trips.status = 'requested' AND driver_id IS
   NULL`, `drivers.status = 'online'`) run in one transaction with `WHERE` guards; if either
   guard fails (0 rows affected), the whole transaction rolls back and the caller treats it as a
   failed claim. In normal operation the Redis lock above already prevents this race from ever
   reaching this point — this is deliberate defense in depth, not the primary mechanism, in case
   the lock layer were ever bypassed by a bug or an unexpected code path.

**Verified directly**: `test/matching.test.ts`, "concurrency: two simultaneous trip requests near
the same single driver — only one wins" — two trips, one driver, `Promise.all([matchTrip(a),
matchTrip(b)])`. Asserts exactly one outcome is `"matched"` and the other is
`"all_candidates_declined"`, the driver ends up `busy` exactly once (not double-booked), exactly
one `trip_offer` was ever sent to the driver (the loser never even tried), and the lock is
released afterward either way.

## Offer / accept / timeout / fallback, over WebSocket

Extends the existing `/ws/driver` connection (`docs/websockets.md`) with a second message shape,
distinguished from a plain location update by the presence of a `type` field (location updates
have none):

```json
// Server -> driver
{ "type": "trip_offer", "tripId": "...", "pickup": {...}, "dropoff": {...}, "offerTimeoutMs": 10000 }

// Driver -> server
{ "type": "trip_response", "tripId": "...", "accept": true }

// Server -> driver, only after the match is actually finalized
{ "type": "trip_matched", "tripId": "...", "pickup": {...}, "dropoff": {...} }
```

`src/ws/trip-offers.ts` bridges `matchTrip`'s `await waitForDriverResponse(tripId, timeoutMs)`
with the WS message handler that receives the response
(`driver-connections.ts` calls `handleDriverResponse(tripId, accepted)`), via a plain in-memory
`Map<tripId, resolve>` — at most one offer is ever outstanding per trip, since only one
`matchTrip` call is ever active for a given trip at a time.

- **No response within `offerTimeoutMs`** → treated identically to an explicit decline; the lock
  is released and the next candidate is tried.
- **Driver has no active WS connection at all** → the offer can't be delivered, so there's no
  reason to wait out the full timeout; this is detected immediately (`sendToDriver` returns
  false) and the next candidate is tried right away.
- **Every candidate exhausted** → see below.

## Two distinct failure outcomes — not a hang, not a silent failure

| Outcome | When | `trips.status` | `trips.cancellation_reason` |
| --- | --- | --- | --- |
| `no_drivers_available` | The nearby search itself returned zero candidates. | `cancelled` | `"no_drivers_available"` |
| `all_candidates_declined` | Candidates existed, but every one declined, timed out, or was unreachable/already locked. | `cancelled` | `"all_candidates_declined"` |

Both reuse the existing `cancelled` status + `cancellation_reason` (Phase 1) rather than adding
new `trip_status` enum values. This is a deliberate choice: Postgres enums support adding a value
but **not removing one** (there's no `ALTER TYPE ... DROP VALUE`), which would make a migration
that adds new statuses effectively irreversible — in tension with this project's migrations
always having a working `down`. The `(status, reason)` pair already gives callers a clear,
distinct signal without that tradeoff; `GET /trips/:id` surfaces `cancellationReason` directly
(unchanged from Phase 2).

Both paths are guarded (`WHERE status = 'requested'`) so they can't clobber a trip that was
somehow resolved by another path in the meantime — if the guard doesn't apply, `matchTrip`
re-fetches and reports the trip's actual current state rather than a stale one.

**Verified directly**: `test/matching.test.ts` — "no drivers available" (pickup far from every
seeded driver) and "all candidates declined" (one reachable driver who always declines) each
assert the specific `(status, cancellationReason)` pair, not just "it didn't crash."

## Notifying both parties

- **Driver**: `trip_offer` on offer, `trip_matched` on confirmed finalize — sent directly to
  their own `/ws/driver` connection (`driver-connections.ts#sendToDriver`).
- **Rider**: if they (or a dispatcher on their behalf) are subscribed to the trip via
  `/ws/subscribe` (`{"type":"subscribe","tripId":...}`, Phase 4), they receive
  `{"type":"trip_matched","tripId":...,"driverId":...}` — `subscriptions.ts#notifyTripMatched`.
  This also **re-indexes** a subscriber who subscribed before a driver was assigned (`driverId:
  null` at subscribe time) onto the newly matched driver, so they start receiving that driver's
  location broadcasts too — this replaces the documented Phase-4 limitation ("re-resolving a
  trip's driver on assignment is Phase 6+ scope") with the real behavior, now that trips can
  actually be matched.
- There's no rider-specific "inbox" WS channel independent of the subscription mechanism — the
  trip subscription IS the rider-side notification channel in this system's current design.

## Verifying it yourself

```
cd core
npm test
```

`test/matching-score.test.ts` — pure unit tests on `scoreCandidate` (distance/idle/rating
ordering, weight configurability, the idle-time cap, no negative/NaN scores at the extremes).

`test/matching.test.ts` — the full flow against a real Postgres + Redis + WebSocket stack:
successful match (with both-party notification), no drivers available, all candidates declined,
fallback-on-timeout (a closer/longer-idle driver stays silent, a farther one accepts), and the
double-booking concurrency race.

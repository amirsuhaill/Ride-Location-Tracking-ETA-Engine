# Frontend: Testing (Frontend Phase 9)

Component/unit tests for the highest-value pure logic (Vitest + React Testing Library), plus one
true end-to-end test (Playwright) against a real running backend — the same disposable
docker-compose stack `core/scripts/test.sh` already uses, with a real scripted driver client
completing the match, not a mocked network layer.

## Unit/component suite: `npm test` — 85 tests, ~3.6s wall clock

```
$ npm test
 Test Files  9 passed (9)
      Tests  85 passed (85)
   Duration  3.63s
```

No manual setup beyond `npm install` — every one of these runs fully in-process (jsdom for the
component tests, plain Node otherwise), no Docker, no network, no real backend.

### The delta-decode function — already comprehensively covered from an earlier phase

`ws/deltaCodec.test.ts` (pre-existing) already exercises exactly what this phase asks for against
real captured-shape message sequences: a full `location` payload decoding standalone, a `delta`
round-tripping within the documented quantization bound, status carried forward when a delta
omits it, a 15-message chain not accumulating error, and — the specific boundary case named in
this phase, mirroring `core/test/ws-delta-compression.test.ts`'s own identical edge case — **"the
very first message a subscriber receives must be a full payload — a delta with no prior state
throws."** Reviewed for this phase and found to need no further additions.

### Fare display formatting — new, `format.test.ts`

```
formatCents(4150, "USD")  -> "$41.50"
formatCents(0, "USD")     -> "$0.00"    // zero must not look like a missing/falsy value
formatCents(1, "USD")     -> "$0.01"    // the smallest nonzero unit
formatCents(2967, "USD")  -> "$29.67"   // a real division-rounding case, not just round numbers
formatCents(8892, "USD")  -> "$88.92"   // the real total from docs/surge-pricing.md's own example
formatCents(500, "EUR")   -> contains "5.00" and "€"   // not hardcoded to USD
```

Amounts are deliberately kept under $1,000 in these tests — this Vitest environment's own default
`Intl` locale resolved to `en-IN`, not `en-US` (confirmed directly:
`Intl.DateTimeFormat().resolvedOptions().locale` → `"en-IN"`), and Indian digit grouping diverges
from Western grouping above four digits (e.g. `100000` → `"1,00,000"` vs `"100,000"`). Every
assertion here holds under both, rather than being accidentally tied to whichever locale a given
machine or CI runner happens to default to.

### The trip-status state machine — transitions (pre-existing) + what each one renders (new)

`hooks/tripTrackingReducer.test.ts` (pre-existing, 12 tests) already covers which transitions are
legal: `subscribed`/`trip_matched` moving `requested` → `matched`, the two distinct `unsubscribed`
reasons (`trip_completed` vs. `trip_cancelled`, the latter alone triggering a `resolve_final_state`
effect since the WS message doesn't carry *which* cancellation reason), the "already ended" race,
and malformed/non-object messages never throwing.

**New**: `components/TripTrackingPanel.test.tsx` (11 tests, React Testing Library) — the other
half this phase specifically asks for, "what each one renders": every status renders distinct,
non-generic text (`requested`/`matched`/`in_progress` are all textually different from each
other), both cancellation reasons render their own real message (not the same string), the
terminal "Request another trip" button appears for `completed`/`cancelled` only, the fare
section correctly switches between the real total and the honest "isn't available" message
(Frontend Phase 8), and the reconnect banner is silent when connected but visible when
reconnecting.

### WebSocket reconnect/backoff — new, `ws/reconnectingSocket.test.ts`, fake timers throughout

A hand-written `FakeWebSocket` (matching the real global `WebSocket`'s constructor/
`addEventListener`/`send`/`close`/`readyState` shape) stood in via `vi.stubGlobal`, driven entirely
by `vi.useFakeTimers()` — no test in this file ever waits on a real clock. 9 tests, including:

- `connect()` reports `connecting` → `connected` on a real `open` event.
- An unexpected close schedules the next attempt at **exactly** the real initial 500ms backoff —
  bracketed with `advanceTimersByTime(499)` (nothing yet) then `+1` (the attempt fires), not just
  "eventually."
- **The full real capped-exponential schedule** — 500 → 1000 → 2000 → 4000 → 8000 → 10000 →
  capped at 10000 — verified the same bracketed way for a chain of consecutive failed attempts.
- A successful reconnect resets the backoff back to 500ms rather than continuing to climb.
- An explicit `close()` never schedules a reconnect, however long you wait.
- A stale `close` event from an already-superseded socket is ignored, not treated as a second real
  drop.

```
$ npx vitest run src/ws/reconnectingSocket.test.ts
 Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  1.04s (tests 9ms)
```

The real-world backoff schedule this file's one "full schedule" test exercises sums to
500+1000+2000+4000+8000+10000+10000 = **26.5 real seconds** if it had used actual `setTimeout`
sleeps. It ran in **9ms** — the fake-timer approach the acceptance criteria asks for genuinely
took, not just "the suite happens to be fast for unrelated reasons."

## The one true end-to-end test: `npm run test:e2e`

`e2e/trip-request.spec.ts` (Playwright, real Chromium) drives the actual rendered rider UI against
a **real** running `core` — real Postgres, real Redis, real WebSocket upgrade — matched by
`e2e/fakeDriverClient.ts`, a real scripted driver client using the exact same connection pattern as
`core/scripts/load-test-driver-fleet.ts` (a real `ws` client, real `POST /drivers`, a real
`/ws/driver?driverId=` socket — never a mocked network layer).

### What it actually asserts (real rendered UI, not "no console errors")

1. A rider places pickup/dropoff via real map clicks; the real resulting coordinates are read back
   from the picking panel (simpler and more robust than back-solving a pixel position for a target
   lat/lng).
2. A real fake driver is created and positioned at that exact point, and the test waits for a real
   `GET /drivers/nearby` to actually confirm it's discoverable — location updates are batched
   server-side (`WS_BATCH_WINDOW_MS`) before reaching Redis, so `sendLocation` returning doesn't
   mean "discoverable yet," and racing ahead of that produced a real, reproducible failure while
   building this test (see below).
3. The rider clicks "Request ride" — a real `POST /trips`, real matching, a real `trip_offer` over
   the real WS connection, auto-accepted by the fake driver.
4. Asserts `"A driver has been matched and is heading your way."` is actually visible.
5. Per `docs/websockets.md`: subscribing to a matched trip does **not** get an immediate position
   snapshot — only the driver's *next* location update does. The fake driver sends one, and the
   test asserts a real `.leaflet-marker-icon[title="Driver"]` becomes visible — not assumed, not
   faked.
6. Captures that marker's real on-screen `transform` (Leaflet positions markers via CSS
   transform), sends a **second**, different real location broadcast on the same live connection,
   and asserts the transform actually changed — the literal meaning of "a live-updating driver
   marker": it moved because a new real message arrived, not because of a one-time initial render.

### Two real bugs this test found while being built (not just passed on the first try)

1. Clicking "Request ride" immediately after the fake driver's WS connection opened raced the
   server's location-batching window — the driver's first location send hadn't reached Redis yet,
   so the real match search found nothing. Fixed by polling a real `GET /drivers/nearby` inside
   `createFakeDriver` until the driver is actually confirmed discoverable, rather than assuming a
   fixed delay was enough.
2. The marker assertion initially expected it to appear immediately after "matched" — it doesn't;
   confirmed directly against `docs/websockets.md`'s own documented behavior and fixed by sending
   one real post-match location update before asserting the marker exists at all.

### How the disposable backend comes up and is torn down

`scripts/e2e-test.sh` (mirrors `core/scripts/test.sh`'s own `trap cleanup EXIT` structure
deliberately, not a reinvention of it):

1. `docker compose --env-file infra/.env.test -f infra/docker-compose.test.yml up -d --wait` — the
   exact same disposable `postgres-test`/`redis-test` pair `core/scripts/test.sh` uses, never the
   dev database/cache.
2. Runs core's real migrations against it (with the same retry-on-`ECONNRESET` loop
   `core/scripts/test.sh` already has, for the same real Postgres/PostGIS entrypoint-restart race —
   this is not hypothetical, it happened on a real run below).
3. Starts a real `core` server (`npx tsx src/index.ts`) on port 3011 — distinct from the normal dev
   port 3000, so this never collides with a locally-running dev instance.
4. Starts a real frontend dev server on port 5181 — distinct from the normal 5173 — pointed at
   that `core` instance via `VITE_CORE_API_URL`/`VITE_CORE_WS_URL`.
5. Runs `npx playwright test`.
6. `trap cleanup EXIT`: kills both processes and `docker compose down -v`, whether the tests
   passed, failed, or the script itself errored out first.

**Real, captured passing output** (a full run, migration SQL detail collapsed for length — the
`ECONNRESET`-then-retry-succeeds sequence is real, not trimmed):

```
--- starting disposable postgres-test/redis-test (infra/docker-compose.test.yml) ---
 Container ride-tracking-test-postgres-test-1  Healthy
 Container ride-tracking-test-redis-test-1  Healthy
--- running core's migrations against the disposable test database ---

> core@0.1.0 migrate:up
> node-pg-migrate up

could not connect to postgres: Error: read ECONNRESET
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20) {
  errno: -54,
  code: 'ECONNRESET',
  syscall: 'read'
}
npm error Lifecycle script `migrate:up` failed with error:
[... the documented postgres/PostGIS entrypoint-restart race — retried, same as core/scripts/test.sh ...]

> core@0.1.0 migrate:up
> node-pg-migrate up

> Migrating files:
> - 1735700001000_enable-postgis
[... 7 migrations, real DDL ...]
Migrations complete!
--- starting a real core server on port 3011 (log: /tmp/ride-tracking-e2e-core.log) ---
--- waiting for core's real /health ---
core is up.
--- starting a real frontend dev server on port 5181 (log: /tmp/ride-tracking-e2e-frontend.log) ---
--- waiting for the frontend dev server ---
frontend is up.
--- running the real Playwright end-to-end suite ---

Running 1 test using 1 worker

  ✓  1 e2e/trip-request.spec.ts:22:3 › real rider request end to end › a rider's request is
     matched by a real driver client, and the driver marker live-updates (4.0s)

  1 passed (4.8s)
--- tearing down: core process, frontend process, disposable postgres/redis ---
```

Confirmed clean afterward, the same run: `docker ps -a` shows no `*-test-*` containers, `ps aux`
shows neither the `tsx src/index.ts` nor the port-5181 `vite` process still running.

### Pointing it at a backend you're already running, instead

`scripts/e2e-test.sh` is the normal path (starts everything, tears it down). To run just
`npx playwright test` against a backend you're already running yourself (e.g. iterating on the
spec file without repaying the full stack-startup cost each time), export the three env vars the
config/spec files read:

```
E2E_APP_URL=http://localhost:5173 \
E2E_CORE_URL=http://localhost:3000 \
E2E_CORE_WS_URL=ws://localhost:3000 \
npx playwright test
```

(defaults, if unset, are the disposable stack's own ports — 5181/3011 — matching
`scripts/e2e-test.sh`, not the normal dev ports, so an accidental bare `npx playwright test` fails
closed with a connection error rather than silently running against whatever happens to be on
5173/3000).

## Verifying it yourself

```
cd frontend
npm install
npm test              # unit/component suite — seconds, no Docker
npm run test:e2e       # real end-to-end — starts its own disposable backend, tears it down after
npm run typecheck      # now covers e2e/ and playwright.config.ts too (tsconfig.e2e.json)
npm run lint
npm run build
```

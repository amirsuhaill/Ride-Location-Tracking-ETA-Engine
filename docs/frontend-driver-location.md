# Frontend: Driver Flow — Go Online & Send Location (Frontend Phase 4)

A driver-facing dashboard on `/driver`: an online/offline toggle with client-side legal-transition
checks, and — while online — a real location stream into `/ws/driver?driverId=<uuid>`, from either
the browser's real Geolocation API or a manual click-to-set fallback, both funneling through one
shared send path.

## A real, previously-latent CORS bug, found by the first real cross-origin `PATCH`

The very first live check — clicking "Go online" in a real browser — failed immediately:

```
Access to fetch at 'http://localhost:3000/drivers/.../status' from origin 'http://localhost:5173'
has been blocked by CORS policy: Method PATCH is not allowed by Access-Control-Allow-Methods in
preflight response.
```

`@fastify/cors`'s own default `methods` list is `GET,HEAD,POST` — confirmed by reading the
installed package's source directly (`node_modules/@fastify/cors/index.js`). This has been true
since Phase 0's CORS fix, but every frontend phase through Phase 3 only ever made `GET`/`POST`
requests from the browser — Phase 4's status toggle is the **first** cross-origin `PATCH` this
project has ever made, and it's what finally exposed the gap. Worse, the existing
`test/cors.test.ts` preflight test only asserted `access-control-allow-methods` *contained*
`"POST"` — true regardless of whether `PATCH` was allowed — so nothing caught this until a real
browser actually tried it.

**Fixed in `core`** (`src/server.ts`): `methods` is now listed explicitly —
`["GET", "POST", "PATCH"]`, every verb this API's routes actually use, not a speculative
"allow everything" list — and a dedicated regression test
(`test/cors.test.ts`, "answers a real CORS preflight (OPTIONS) request for a PATCH route") asserts
`access-control-allow-methods` contains `PATCH` specifically, so this exact gap can't silently
reappear. Full suite: **202 tests passing** (198 + 3 CORS + 1 new).

## Client-side legal-transition mirroring

`src/driverStatusRules.ts#canTransitionDriverStatus` mirrors `docs/API.md`'s table exactly
(`offline→online` ✅, `offline→busy` ❌, `online→offline`/`online→busy` ✅, `busy→online` ✅,
`busy→offline` ❌) — 7 unit tests (`driverStatusRules.test.ts`). The dashboard's toggle button is
disabled the instant a transition would be illegal (e.g. while `busy`, "go offline" is replaced
with an explanatory message), rather than firing the request and waiting on a `409` core would
correctly reject anyway. This never replaces the backend's own enforcement — it's purely a faster,
friendlier failure mode for the same rule.

## One send path, two input sources

`src/ws/driverSocket.ts#sendLocation(lat, lng)` is the **only** place a `{lat,lng,timestamp}`
message is ever constructed and sent. `src/hooks/useDriverLocationStream.ts` calls it from two
places — the real Geolocation `watchPosition` callback (throttled) and
`sendManualPosition` (immediate, for the click-to-set fallback) — but both are thin wrappers
around the identical call, never a second/duplicated send implementation.

### Send throttle: 1000ms, matching `WS_DRIVER_THROTTLE_MS`'s own default

Sending faster than the server's own per-driver throttle accepts is pure waste — the extra
messages are coalesced (last-value-wins) server-side, not queued or applied
(`docs/websockets.md`'s "Throttling" section) — so a shorter client interval buys nothing. Sending
slower leaves that server-side allowance unused for no reason. 1000ms is also a plausible real GPS
reporting cadence, not just a number picked to match the backend.

### Geolocation errors are explicit, never a silent stall

`src/components/GeolocationStatusBanner.tsx` renders a distinct message for each real failure
mode: permission `denied`, the API being `unsupported` in this browser, or a generic `error`
(timeout/unavailable) — every one of them explicitly pointing at the manual click-to-set fallback,
never a screen that just... does nothing.

### Reused, not reinvented, socket lifecycle

`src/ws/driverSocket.ts` and Frontend Phase 1's `SubscriberSocket` need the identical
connect/reconnect-with-backoff/explicit-teardown lifecycle — factored into a shared
`src/ws/reconnectingSocket.ts` base class once the duplication became concrete (a second
near-identical class), not pre-emptively. `SubscriberSocket` was refactored onto the same base with
no behavior change — its own 17 existing tests (`deltaCodec.test.ts`,
`tripTrackingReducer.test.ts`) still pass unchanged, confirming the refactor was safe.

### Stopping is real: both the WebSocket and `watchPosition` close, not just the UI

`useDriverLocationStream`'s effect is keyed on `active` (`status === "online"`) — going offline (or
unmounting) tears down `DriverSocket#close()` **and** calls `navigator.geolocation.clearWatch`,
both in the same cleanup. Verified live below by literally counting outbound WS frames before and
after, not by checking that the dashboard's own display went quiet.

## Verified live (real browser, real mocked GPS, real Docker containers)

```
=== 1. Create a driver, go online ===
driver is online

=== 2. Real Geolocation path: a real watchPosition callback sends a real update ===
frames sent so far (geolocation path): 1
first frame: {"lat":37.76,"lng":-122.44999999999999,"timestamp":1785911638018}

=== 3. Independently verifiable from another client (GET /drivers/nearby) ===
found via /drivers/nearby (separate fetch):
  {"driverId":"b279ec5b-...","distanceMeters":0.1067,
   "location":{"lat":37.760000919591185,"lng":-122.45000034570694}, ...}

=== 4. Manual click-to-set fallback: same send path, verified the same way ===
manual click frame: {"lat":37.77682066490566,"lng":-122.37791061401369,"timestamp":1785911638401}
found via /drivers/nearby after manual click:
  {"driverId":"b279ec5b-...","distanceMeters":0.2471,
   "location":{"lat":37.77682132920456,"lng":-122.37791329622269}, ...}

=== 5. Toggling offline stops outbound messages (not just hides the UI) ===
driver is offline
WS frames before going offline: 2, 3s after: 2

=== 6. Waiting past DRIVER_STALE_MS (90s) with no updates: driver disappears from nearby ===
driver still in /drivers/nearby after 95s offline+stale: false

ALL PHASE 4 CHECKS PASSED
```

Notes on how this was actually driven, honestly:

- **"Real Geolocation"** here means Playwright's browser context was granted geolocation
  permission and given a mocked coordinate (`context.geolocation`) — the browser's *real*
  `navigator.geolocation.watchPosition` API fires with that coordinate exactly as it would with a
  real GPS fix. This exercises this project's own code for real; only the underlying hardware
  signal is substituted, which is the only thing a CI/automated environment realistically can
  substitute.
- **Frame capture** used Playwright's `page.on("websocket")` → `ws.on("framesent")` API — the same
  outbound-frame signal a human would read off Chrome DevTools' Network → WS panel, just
  captured programmatically so "confirm in devtools" becomes a real, repeatable assertion instead
  of an eyeballed one-time check.
- **Step 6's 95-second wait is real, not simulated** — `DRIVER_STALE_MS`'s actual configured value
  (confirmed via `docker compose exec core printenv DRIVER_STALE_MS` → `90000`) plus margin, no
  shortcut taken.
- Both `/drivers/nearby` lookups in steps 3 and 4 were plain `fetch()` calls from the Node script
  itself — a genuinely separate client from the browser tab that sent the location, not the same
  tab reading its own state back.

## Verifying it yourself

```
make up   # postgres, redis, core
cd frontend && npm run dev   # http://localhost:5173/driver

npm test          # includes driverStatusRules.test.ts (7 tests)
npm run typecheck
npm run lint
npm run build

cd ../core && npm test   # includes the new PATCH CORS regression test — 202 tests
```

To reproduce the Geolocation-path check without real GPS hardware, grant geolocation permission
to your browser profile and either physically move, or (for an automated check) use Playwright's
`browser.newContext({ permissions: ["geolocation"], geolocation: {...} })` the same way this
phase's own verification did.

# Frontend: Resilience & Edge States (Frontend Phase 8)

A sweep over every screen for the failure/edge states a live system actually produces — a dropped
WebSocket mid-session, a driver with nothing nearby, a trip nobody's ever priced, a rider whose
phone loses signal — each given its own honest, distinct UI state instead of a spinner that never
resolves or a single generic error.

## WebSocket reconnect: already had real backoff (Phase 4), was missing visibility

`ws/reconnectingSocket.ts` (Frontend Phase 4) already does exactly what this phase asks for:
capped exponential backoff (500ms → 1s → 2s → 4s → 8s → capped at 10s — a short first retry since
a drop is often transient, doubling from there so a genuinely-down backend isn't hammered), and
`SubscriberSocket#onOpen` already resends whatever was last subscribed to on every reconnect. What
was missing was **surfacing it** — `useTripTracking`'s `connectionState` was tracked but never
rendered anywhere on the rider's screen, and `DriverDashboard`'s connection label had been moved
into the phone `BottomSheet`'s collapsed-by-default `detail` section during Frontend Phase 7's
responsive pass, meaning a driver whose connection silently dropped wouldn't see anything without
first expanding the sheet.

**Fixed**: a new `ConnectionStatusBanner.tsx` (same `role`/tone/`aria-live` convention
`GeolocationStatusBanner` already established) renders a visible amber "Reconnecting… your
connection was interrupted." for the one state this phase is actually about, silent for
"connected" (the common case). Wired into the rider tracking screen's always-visible peek (new)
and the driver dashboard's peek (moved out of the collapsed `detail`) — both places it's now
impossible to miss without an extra "expand" gesture, the same reasoning Phase 7 already applied
to `TripOfferPanel`'s accept/decline countdown.

## Full network loss: a real, app-wide banner

`NetworkStatusBanner.tsx`, mounted once in `AppShell` above every route, watches two independent
real signals:

- **`navigator.onLine` / `online`/`offline` events** (`useNetworkHealth.ts`) — the device's own
  "no network interface at all" signal.
- **Repeated failures to reach core specifically** — a tiny pub-sub added to `api/client.ts`
  (`onNetworkHealthChange`) that flips "unhealthy" after two consecutive `network_error` results
  (never an `api_error` — a 4xx/5xx means the request *did* reach a server, so it's not a
  connectivity problem) across *any* call, not just whichever hook happens to be polling.

Two distinct messages, not one generic "something's wrong": "You're offline" (red) when the
browser itself has no connection, "Can't reach the server right now — retrying automatically."
(amber) when the network's up but core specifically isn't answering.

## Distinguishing transient from "needs a person to act"

Two concrete, previously-unhandled instances, not just the already-correct geolocation-permission
case (Phase 4's `GeolocationStatusBanner` already never auto-retries a denied permission):

1. **`CoordinateEntryForm`'s lat/lng inputs had no bounds checking at all.** Typing `200` for
   latitude would reach `useSurgeAtPoint` and 400 on *every single poll, forever*, with the UI
   stuck showing "loading…" — a real instance of the exact anti-pattern this phase is about.
   Fixed with real client-side validation (`coordinateValidation.ts`) matching core's own schema
   bounds exactly (`-90..90`/`-180..180`, `constants.ts`) — caught immediately, before any network
   round-trip, with an inline error message. A bug in the validation logic itself
   (`Number("")` is `0`, not `NaN` — an empty field would have silently become a real coordinate)
   was caught by its own unit test (`coordinateValidation.test.ts`) on the first run.
2. **`useSurgeAtPoint`/`useSurgeZones`/`useTripEta` didn't distinguish failure types at all** —
   any failure just silently kept the last-known value, poll interval unchanged. Now: a
   `network_error` is left alone (transient, the app-wide banner already covers it, and the exact
   same request is worth retrying); a permanent `api_error` stops the poll entirely (retrying a
   request that can only ever fail the same way again is pure waste) and surfaces a distinct,
   honest message instead of an eternal "loading…".

## Empty states: three, each only once its own data has genuinely loaded

The core fix underlying all three: an empty array/`null` is ambiguous between "confirmed nothing
here" and "hasn't fetched yet" — both need to render differently. `useSurgeZones` now returns
`hasLoaded` alongside `zones`; `DriverMap` tracks its own `driversLoaded` the same way (`onDrivers`
firing at all — even with zero results — is the real "we now know for sure" signal, not
`drivers.length`).

- **"No drivers online nearby right now."** — `DriverMap`, once `driversLoaded && drivers.length
  === 0`.
- **"No zones currently showing surge."** — `DriverMap`, once `surgeLoaded && zones.length === 0`.
- **"Fare estimate isn't available for this trip."** — `TripTrackingPanel`, whenever
  `trip.fareEstimate` is absent. Only reachable one real way: `fareEstimate` exists *only* on the
  original `POST /trips` response, never on a later `GET /trips/:id` (docs/API.md) — see below for
  how a real `GET` response ends up driving this screen at all.

### A real feature this phase needed to build to reach that third state honestly: trip-resume-after-reload

There was no existing, live-triggerable path to a rendered `Trip` without a `fareEstimate` — the
rider flow's `flow.trip` was set once from the `POST /trips` response and never replaced. Rather
than hardcode the UI into that state to screenshot it, `TripRequestFlow.tsx` now persists the
active `tripId` to `localStorage` (`ride-tracking.currentTripId`, the same pattern
`useRiderIdentity` already established) and, on mount, resumes an in-progress trip via a real
`GET /trips/:id` if one is remembered — clearing the stored id once the trip reaches a real
terminal state (or the trip is simply gone/404) so a finished trip is never resumed. This is a
genuine resilience improvement in its own right (a reload no longer orphans an active trip the
rider is still on), not merely a means to an empty-state screenshot.

## Verified live (real Docker containers, real `core` stop/start, no shortcuts)

### Criterion 1 — every affected screen recovers without a manual reload, real elapsed time

Three simultaneous live connections (a rider tracking a matched trip, a driver's own `/ws/driver`
connection, a dispatcher tracking that same driver via a separate `/ws/subscribe`), `core` stopped
and restarted **twice** in the same session:

```
=== CYCLE 1 ===
core stopped at t=1785929..., all 3 screens confirmed showing "Reconnecting…"
core restarted
rider screen recovered 3180ms after core restart
driver screen recovered 3182ms after core restart
dispatcher screen recovered 3186ms after core restart

=== CYCLE 2 ===
core stopped again — all 3 screens confirmed reconnecting again
core restarted again
all 3 screens recovered again, 3231ms after the second restart
```

~3.2 seconds both times — consistent with `ReconnectingSocket`'s real backoff schedule (the first
attempt after a drop is 500ms, doubling from there; landing around the 3.2s mark means recovery
happened within the first few real backoff attempts once core was actually listening again, not a
lucky one-off).

### Criterion 3 — resubscription is idempotent, verified by exact-position round-tripping

After each reconnect cycle, the driver sent an exact, manually-entered coordinate (via
`CoordinateEntryForm` — full control over precisely when a new position goes out, rather than
relying on `watchPosition`'s own timing). `deltaCodec.ts`'s decoding is stateful/relative — if a
broadcast were ever delivered twice (a stale subscription surviving a reconnect, alongside the new
one), the displayed position would be wrong, not just late:

```
sent exact position 37.7891, -122.4011 — dispatcher badge now reads:
  "Tracking bec0c675… — live37.78910, -122.40110"
dispatcher shows the exact sent position (no duplicate-delta corruption): true

[... a SECOND full stop/restart cycle ...]

sent exact position 37.7712, -122.4355 — dispatcher badge now reads:
  "Tracking bec0c675… — live37.77120, -122.43550"
dispatcher shows the exact sent position after 2 reconnects (idempotent, no duplication): true
```

Both positions matched exactly, after one reconnect and after two — no duplicate/corrupted
position ever appeared.

### Criterion 2 — every empty state, screenshotted from a real trigger, not hardcoded

| State | How it was really triggered | Screenshot |
| --- | --- | --- |
| No drivers nearby | A real dispatcher map panned (zoom + drag) far from every seeded/online driver, until a genuinely empty `GET /drivers/nearby` response came back | `empty-state-no-drivers-nearby.png` |
| No surge zones | `surge:state`, the real Redis hash `surge.repository.ts` reads (confirmed via `redis-cli DEL`), flushed live, with a real online driver kept in view the whole time (proving this is specifically the surge-empty state, not "nothing loaded at all") | `empty-state-no-surge-zones.png` |
| No fare estimate | A real trip requested, then resumed from a genuinely separate page load via the new trip-resume feature (`GET /trips/:id`, no `fareEstimate` field, exactly as documented) | `empty-state-no-fare-estimate.png` |

And the two network-loss banners, also live:

| State | How it was really triggered | Screenshot |
| --- | --- | --- |
| Offline | `context.setOffline(true)` — Playwright's real `navigator.onLine` flip + browser `offline` event, not a DOM mock | `network-banner-offline.png` |
| Server unreachable | `core` stopped (network itself untouched) | `network-banner-server-unreachable.png` |

Both banners cleared on their own once the real condition resolved (network restored / `core`
restarted) — no reload needed, confirmed live in the same run.

## Verifying it yourself

```
make up   # postgres, redis, core
cd frontend && npm run dev   # http://localhost:5173

npm test          # includes coordinateValidation.test.ts (7 tests)
npm run typecheck
npm run lint
npm run build
```

To reproduce the reconnect/idempotency check: open the rider, driver, and dispatcher screens
against a real matched trip, then `docker compose stop core` / `start core` (repeat twice), timing
each screen's own reconnect-banner disappearance. To reproduce an empty state without hardcoding
it: pan the dispatcher map away from any real driver, or `redis-cli DEL surge:state` directly. To
reproduce the offline banner without real hardware: a Playwright context's `setOffline(true)`, or
your browser devtools' own "Offline" network throttling preset.

# Frontend: Rider Flow — Request a Ride (Frontend Phase 2)

The rider-facing request flow on `/`: a minimal rider-identity step gating access, a two-pin
pickup/dropoff picker, and `POST /trips` with the real `fareEstimate` rendered verbatim.

## Rider identity: create-or-select, before the request screen exists at all

`src/hooks/useRiderIdentity.ts` — no login system exists for this project, so a riderId/name pair
is persisted in `localStorage` after a one-time `POST /riders`. On every load, the stored id is
**re-verified against `GET /riders/:id`** — not just trusted — so a stale id (e.g. the dev database
was reset) is caught proactively and routed back to the create-rider step, rather than surfacing
as a raw 404 later when the rider actually tries to request a trip. This is what "handled before it
can happen" means here: the trip-request screen (`TripRequestFlow`) is structurally unreachable
without a real, currently-existing `riderId` in hand.

## Two-pin picker: unambiguous, and always revisable

`src/components/TripRequestMap.tsx` — the **first** map tap places pickup and auto-advances to
dropoff; the **second** places dropoff. A status banner always names which pin the next tap will
affect. Critically, this isn't one-shot:

- **Drag** either placed pin at any time — `dragend` always updates that pin's coordinates,
  regardless of which one is "active."
- **Tap the other pin** to make it active again, so the *next map tap* revises it instead of the
  currently-active one (rather than being stuck advancing forward only).

Both pickup and dropoff carry a `title` attribute ("Pickup"/"Dropoff") — primarily for real
Playwright-driven verification (below), incidentally also a native browser tooltip on hover.

## Double-submit: a ref, not just a disabled button

`TripRequestFlow`'s `submittingRef` is a plain mutable ref checked and set **synchronously** at
the very first line of `handleSubmit`, before any `await`. A React state flag alone isn't a
reliable guard here: two click events dispatched back-to-back can both run their handler before a
state update has actually re-rendered the button as `disabled` — there's a real gap. A ref
mutation has no such gap; the second invocation's check-and-bail happens in the same synchronous
step as the first invocation's check-and-proceed. The `disabled` attribute is still set (for
real UX — the button visibly stops being clickable), but the *correctness* guarantee comes from
the ref, not the DOM attribute. Verified with the strongest possible race below: two native
`button.click()` calls in one synchronous `page.evaluate`, not two separate, frame-apart Playwright
clicks.

## Fare: rendered verbatim, formatted with `Intl.NumberFormat`

`src/format.ts#formatCents` divides by 100 and hands off to a cached `Intl.NumberFormat` per
currency code — the only "computation" performed client-side. Every actual number
(`baseCents`/`distanceCents`/`timeCents`/`subtotalCents`/`surgeMultiplier`/`totalCents`) is
whatever `POST /trips` actually returned, never re-derived — the surge multiplier in particular is
a live, backend-computed value (`docs/surge-pricing.md`) that this screen has no way to reconstruct
correctly on its own.

## Three distinct failure paths, not one generic toast

| Case | How it's produced | What's shown |
| --- | --- | --- |
| Out-of-range coordinate | A real 400 from `POST /trips` | The backend's exact `error.message` (e.g. `"pickup.lat: lat must be between -90 and 90"`) |
| Unknown `riderId` | A real 404 — structurally prevented from reaching this screen at all (see above) | N/A in the request flow itself; the identity hook's own `check_failed`/`needs_rider` states handle it earlier |
| Backend unreachable | `fetch()` itself throws (offline, connection refused) | `"Can't reach the server — <detail>"` — a distinctly different message from a validation error, via `describeApiFailure`'s `network_error` branch (`src/api/client.ts`) |

No client-side coordinate validation blocks a request before it's sent — that would prevent the
backend's own message from ever being seen, defeating the point. The map's normal tap/drag
interaction can't actually produce an out-of-range coordinate anyway (Leaflet's Web Mercator
projection has its own asymptotic latitude limit, well short of ±90, long before any UI-level
validation would matter) — the real verification below reflects that honestly, corrupting a
coordinate in-flight rather than pretending a normal drag could produce one.

## Verified live (real browser, real Postgres, real backend errors)

```
=== 1. Real trip row in Postgres, matching what's shown on screen ===
fare breakdown shown in UI: "Base$2.50Distance$4.08Time$1.42Subtotal$8.00Surge ×1Total$8.00"
trip count before: 1, after: 2
latest trip row: b9f23252-... | 37.77003627110174 | -122.43799209594728 | 37.78360443615261 | -122.41224288940431

=== 2. Rapid double-click submit -> exactly one trip row (separate scenario) ===
trip count before: 2, after double-click: 3

=== 3. Out-of-range coordinate (malformed request) shows the backend's exact message ===
error shown: "pickup.lat: lat must be between -90 and 90"

ALL PHASE 2 CHECKS PASSED
```

The double-submit check used the strongest realistic race: `document.querySelector('button')`'s
native `.click()` called twice in one synchronous `page.evaluate` block — stronger than two
separate Playwright `.click()` calls (which each yield a frame), and the trip count still moved by
exactly one, confirming the ref guard (not just React's own re-render timing) is what's actually
preventing the second request.

The out-of-range case used `page.route()` to intercept the real outgoing `POST /trips` and corrupt
`pickup.lat` to `200` just before it reached the real backend — "a deliberately malformed request,"
the acceptance criteria's own stated alternative to forcing it through devtools — and the exact
returned message is what's rendered, not a client-side re-statement of it.

## Responsive layouts

| Phone (375px) | Desktop (1280px) |
| --- | --- |
| `docs/screenshots/rider-phone-375.png` — map on top, form below, bottom tab bar | `docs/screenshots/rider-desktop-1280.png` — map fills the remaining width, fixed side panel |

Same breakpoint as the rest of the app (`sm`, 640px — `docs/frontend-shell.md`), not a
new one introduced just for this screen.

## Verifying it yourself

```
make up
cd frontend && npm run dev            # http://localhost:5173/

npm run typecheck
npm run lint
npm test
npm run build

# after requesting a trip in the UI:
docker compose -f ../infra/docker-compose.yml exec postgres \
  psql -U ridetracking -d ridetracking -c \
  "SELECT id, status, requested_at FROM trips ORDER BY requested_at DESC LIMIT 1;"
```

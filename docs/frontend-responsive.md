# Frontend: Responsive Design Pass & Cross-Device Verification (Frontend Phase 7)

A dedicated pass over every screen built so far (rider request/tracking, driver dashboard,
dispatcher fleet map): explicit breakpoints with a real structural difference at each one (not
font-size scaling), a stated minimum touch target audited everywhere, `env()` safe-area handling
for the bottom tab bar/sheet, and a keyboard-navigation pass — including a real keyboard-operable
alternative to tapping the map, which has no native keyboard equivalent otherwise.

## Breakpoints: phone / tablet / desktop, and what actually changes

`frontend/src/ui.ts` and `frontend/src/hooks/useBreakpoint.ts` are the two places these numbers
live. Tailwind's own defaults are reused as-is (no `@theme` override) because they already land
exactly on this phase's three requested tiers:

| Tier | Width | Tailwind prefix |
| --- | --- | --- |
| Phone | < 640px | unprefixed (mobile-first base) |
| Tablet | 640–1023px | `sm:` |
| Desktop | >= 1024px | `lg:` |

What actually changes, not just spacing:

- **Phone**: the map (`TripRequestMap`/`TripTrackingMap`/`DriverLocationMap`) renders full-bleed
  (`absolute inset-0` of its container), with a **draggable `BottomSheet`** anchored to the bottom
  holding trip/driver details, collapsed to a peek by default. `AppShell`'s bottom tab bar
  replaces the top nav.
- **Tablet**: a conventional fixed-width (320px) side panel next to the map instead — no overlay,
  no collapse/expand concept at all. `AppShell`'s top nav bar replaces the bottom tab bar.
- **Desktop**: the same side panel widens to 384px (`lg:w-96`) — real breathing room for the
  fare/ETA line items once there's horizontal space to spend on it, not a cosmetic tweak.

**Which layout renders is decided once, in JS (`useBreakpoint`), not by mounting both and hiding
one with CSS.** The first implementation did exactly that (a `sm:hidden`/`hidden sm:block` pair)
and it worked visually, but it means two live copies of every interactive control (submit button,
accept/decline, etc.) exist in the DOM at once — a real duplicate-tab-stop trap for keyboard users
and, concretely, what broke this phase's own Playwright verification script (`page.click()`
resolved to two matching buttons and picked whichever wasn't actually visible). Refactored to
`useBreakpoint()` picking exactly one tree to render.

`TripRequestFlow.tsx` and `DriverDashboard.tsx` both split their panel content into a `peek`
(always visible, even collapsed on phone — critically, this includes `TripOfferPanel`'s
accept/decline countdown, since hiding a time-sensitive control behind an "expand" gesture would
be a real usability regression) and `detail` (supporting info, phone-collapsed-only). Desktop/
tablet render both without duplication — while tracking a trip, showing the same status/fare
summary from both the peek and the full panel back-to-back would just be visual noise, so the
side panel shows the full panel alone in that case.

`DispatcherView`/`DriverMap` doesn't get a bottom sheet — there's no "trip details" content there,
just a small tracked-driver status badge, which was already an appropriately minimal overlay at
every width. It did need its own Phase 7 fixes (below).

## Touch targets: 44×44 CSS px, audited everywhere — not just primary buttons

Chosen per Apple's HIG and WCAG 2.5.5 (Level AAA) rather than Material's 48×48dp — see
`ui.ts`'s `TOUCH_TARGET_PX` for the full rationale. `TOUCH_TARGET_CLASS` (`min-h-11 min-w-11` —
Tailwind's `11` step is exactly 2.75rem = 44px) was applied to every real interactive control
across the app: every button (submit, accept/decline, go online/offline, retry, request-another,
coordinate-entry toggle/set/cancel, drivers-list toggle/items), every form input (rider/driver
sign-up, coordinate entry), and both navs in `AppShell`.

**Two real, previously-invisible violations were found and fixed by actually measuring, not
eyeballing:**

1. **Leaflet's own zoom in/out controls default to 26×26 (30×30 via Leaflet's own `.leaflet-touch`
   variant)** — under the 44px bar, and not something any of this project's own component code
   controls directly. Fixed with a `.leaflet-bar a { width/height/line-height: 44px !important; }`
   override in `index.css`. `!important` is deliberate here, not sloppy — `leaflet/dist/leaflet.css`
   is imported per-component, so its own `<style>` tag can land *after* this file's in the
   document, and at equal selector specificity source order would otherwise decide the winner.
2. **The map's own zoom control collided with this phase's new overlay controls** (the
   coordinate-entry toggle, the dispatcher's drivers-list toggle) — both default to the same
   top-left corner Leaflet itself uses, so one visually covered the other (confirmed by screenshot,
   not just measurement — see `responsive-driver-phone.png`/`responsive-dispatcher-phone.png`
   before/after in git history). Fixed by relocating Leaflet's zoom control per screen
   (`<ZoomControl position="topright">` on the rider/driver maps, `"bottomright"` on the dispatcher
   map, chosen per-screen so it never lands on top of that screen's own other overlays).

**One documented, deliberate exception**: the OSM/Leaflet attribution links in the map's
bottom-right corner are left at their default (tiny) size. This is a licensing requirement
(https://www.openstreetmap.org/copyright), not a control this app designed for frequent
interaction, and every project built on Leaflet/OSM tiles leaves it exactly as-is — enlarging that
text to a 44px target would look absurd against its own font size. The audit script excludes it
explicitly and reports the exclusion count on every run rather than silently dropping it.

**Audit result, real Playwright measurements, all 4 screens × all 3 breakpoints**: 87 real
interactive controls measured, **0 under 44px**, plus the 24 (2 per screen × 4 screens × 3
breakpoints) documented attribution-link exclusions above.

## Safe-area-inset: the bottom tab bar (and, generally, `BottomSheet`)

`AppShell`'s bottom tab bar (the one UI element that actually sits at the true bottom edge of the
viewport on phone) gets `paddingBottom: max(0.5rem, env(safe-area-inset-bottom))` — 0 on devices
without a notch/home-indicator, a real inset on ones that have one, so the tab bar's own tap
targets never end up underneath it. `BottomSheet`'s own expanded-content area carries the same
padding defensively, for any future context where it isn't guaranteed to sit above a bottom nav bar
the way it does in this app today.

## Keyboard navigation: including map pin placement

Every button/link/input in this app was already a real semantic element (Phase 0's `FOCUS_RING`
convention, now `FOCUS_RING_CLASS` in `ui.ts`), so most of the app was already keyboard-operable.
Two gaps were real, and fixed:

1. **Map pin placement had no keyboard equivalent at all** — clicking/dragging a Leaflet map is a
   mouse/touch-only interaction. Rather than attempt to make the map canvas itself
   arrow-key-navigable (a much larger, riskier undertaking for a "basic pass," and Leaflet has no
   built-in support for it), `CoordinateEntryForm.tsx` exposes the *exact same* underlying action
   (`onSetPickup`/`onSetDropoff`/`onManualSet`) as a plain, Tab-reachable lat/lng form — a toggle
   button, then two number inputs and a submit button once open. Added to `TripRequestMap` (aware
   of the current active pin, exactly like a map tap would be) and `DriverLocationMap`.
2. **`BottomSheet`'s drag handle** is a real `<button>` with `aria-expanded`, togglable by a plain
   click/Enter/Space, plus explicit ArrowUp/ArrowDown — no "hold and drag" required at all.
3. **Dispatcher's driver selection** (previously marker-click-only) got a parallel Tab-reachable
   `Drivers (N)` list — same `onSelectDriver` callback a marker click uses.

**Verified live** (`verify-phase7-keyboard.mjs`, real Playwright keyboard events, no
mouse/pointer calls at all):

```
=== Rider request flow: keyboard reachability (phone width, no mouse) ===
reached "Set pickup by coordinates" toggle via Tab: true (after 6 tabs)
Enter opened the coordinate-entry form: true
focus landed on: <input> (expect an input for Lat)
focus before submitting: <button> "Set"
pickup marker placed via keyboard-only coordinate entry (no map click at all): true
map's own status banner now reads: "Tap the map to set your dropoff point."

=== BottomSheet: keyboard expand/collapse (ArrowUp/ArrowDown, no drag) ===
reached the BottomSheet's drag-handle button via Tab: true (aria-expanded=false)
detail content visible before expanding: false
ArrowUp -> aria-expanded="true", detail content now visible: true
ArrowDown -> aria-expanded="false" (back to collapsed)

=== AppShell: keyboard navigation between screens (bottom tab bar) ===
reached the "Driver" tab via Tab: true (after 2 tabs from where we left off)
Enter navigated to: http://localhost:5173/driver

=== Dispatcher: Drivers list keyboard reachability (no marker clicks) ===
reached the "Drivers (N)" toggle via Tab: true (Drivers (0))
Enter opened the drivers list: true
```

## A real bug found while building `BottomSheet`: fixed collapsed height, not measured content

The first implementation used a flat `COLLAPSED_HEIGHT_PX = 64` for the sheet's collapsed state.
Since the drag handle button alone is 44px tall (the touch-target minimum above), that left only
20px for the actual peek content — real screenshots showed trip status/fare text clipped off
entirely (`overflow: hidden` silently ate it). Fixed with a `ResizeObserver` measuring the actual
rendered handle+header content and using *that* as the collapsed height, re-measuring whenever the
header's own content changes shape (an error message appearing, a countdown replacing a status
line). A fixed fallback (120px) only covers the very first paint before the first real measurement
lands.

## Verified live: screenshots at all 3 breakpoints, all 4 screens

Real Docker containers (`postgres`, `redis`, `core`), a real online driver, a real matched trip,
and a real dispatcher fleet view — `docs/screenshots/responsive-{screen}-{breakpoint}.png`:

| Screen | Phone (375px) | Tablet (768px) | Desktop (1280px) |
| --- | --- | --- | --- |
| Rider request | `responsive-rider-request-phone.png` | `responsive-rider-request-tablet.png` | `responsive-rider-request-desktop.png` |
| Live tracking | `responsive-rider-tracking-phone.png` | `responsive-rider-tracking-tablet.png` | `responsive-rider-tracking-desktop.png` |
| Driver view | `responsive-driver-phone.png` | `responsive-driver-tablet.png` | `responsive-driver-desktop.png` |
| Dispatcher map | `responsive-dispatcher-phone.png` | `responsive-dispatcher-tablet.png` | `responsive-dispatcher-desktop.png` |

No horizontal scroll or clipped content at any of the 12 combinations — checked programmatically
(`document.documentElement.scrollWidth <= clientWidth`), not eyeballed:

```
[scroll] responsive-driver/phone: scrollWidth=375 clientWidth=375 OK
[scroll] responsive-driver/tablet: scrollWidth=768 clientWidth=768 OK
[scroll] responsive-driver/desktop: scrollWidth=1280 clientWidth=1280 OK
[scroll] responsive-rider-request/phone: scrollWidth=375 clientWidth=375 OK
... (all 12 combinations: OK, 0 overflow)

Horizontal overflow anywhere: false
Total touch-target violations across all screens/breakpoints: 0
```

## Real Lighthouse mobile score and bundle size — reported honestly

Against a real production build (`npm run build` + `vite preview`, not the dev server — dev-mode
serves unminified/unbundled modules, which would misrepresent real load cost):

```
$ npm run build
dist/assets/index-*.css   30.36 kB │ gzip:  10.26 kB
dist/assets/index-*.js   425.25 kB │ gzip: 129.96 kB
```

**Lighthouse (mobile, real Chrome, simulated throttling)**:

| Category | Score |
| --- | --- |
| Performance | 98 |
| Accessibility | 100 |
| Best Practices | 96 |
| SEO | 82 |

Core Web Vitals: First Contentful Paint 1.6s, Largest Contentful Paint 2.1s, Time to Interactive
2.1s, Total Blocking Time 30ms, Cumulative Layout Shift 0.

**The biggest real cost, measured, not guessed**: breaking down the production bundle by package
(pre-minification module sizes, since minification doesn't shift relative proportions much):

```
react-dom                      50.2%
leaflet                        26.4%
react-router                    9.8%
(other app code + smaller deps) 9.2%
react                           1.8%
@react-leaflet/core             1.0%
scheduler                       1.0%
react-leaflet                   0.5%
```

React + ReactDOM (the framework itself) is actually the single largest cost, edging out the map
library — but Leaflet is still the largest *non-framework* dependency by a wide margin, and
Lighthouse's own "Reduce unused JavaScript" diagnostic (est. 82 KiB) is consistent with that: a
generic map library ships tile-layer types, path renderers, and interaction handling this app
doesn't exercise. No action taken on it this phase (out of scope for a responsive-design pass —
swapping or code-splitting the map library is a real, separate undertaking), but it's the honest
answer to "what's the biggest cost," not a guess.

Two Lighthouse findings worth naming explicitly rather than silently omitting:

- **A console CORS error was flagged** — `core`'s `CORS_ORIGINS` allowlist (Phase 0) includes the
  Vite *dev* server's origin (`http://localhost:5173`), not `vite preview`'s port (`4173`, only
  used for this one-off Lighthouse run). This is an artifact of testing the production build
  in isolation from a matching deployed origin, not a real app bug — a real deployment would add
  its actual serving origin to that same allowlist, same as any other environment.
- **`robots.txt` was flagged as invalid** — this app has no dedicated `robots.txt`, so the dev/
  preview server's SPA fallback serves `index.html` for that path instead, which Lighthouse
  (correctly) can't parse as robots directives. Expected for an internal ops tool, not a
  public-facing site with real SEO requirements — not fixed this phase, named honestly instead of
  silently target-scoring around it.

## Verifying it yourself

```
make up   # postgres, redis, core
cd frontend && npm run dev   # http://localhost:5173, /driver, /dispatcher

npm run typecheck
npm run lint
npm run build

npm run preview -- --port 4173   # serves the real production build
npx lighthouse http://localhost:4173/ --output=html --view
```

To reproduce the screenshot/touch-target/scroll audit, resize a real Playwright page to 375×812
(phone), 768×1024 (tablet), and 1280×800 (desktop) against each route, screenshot at each, and
measure every `button, a[href], input, select, textarea, [role='button']`'s
`getBoundingClientRect()` against the 44px minimum (excluding `.leaflet-control-attribution`
links, per the documented exception above). For the keyboard pass, drive the same routes with
`page.keyboard.press("Tab"/"Enter"/"ArrowUp"/"ArrowDown")` only — no `page.click()`/`page.tap()`
calls at all.

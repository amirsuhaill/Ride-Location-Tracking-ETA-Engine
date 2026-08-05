# Frontend: Surge & Zone Visualization (Frontend Phase 6)

A live map overlay for `GET /surge` (`SurgeOverlay.tsx`, mounted on the dispatcher's fleet map,
`/dispatcher`) — one colored circle per tracked zone, sized with this project's own real
`SURGE_ZONE_RADIUS_METERS`, plus a permanent numeric label so the multiplier is legible without
relying on color alone. Separately, the rider request flow (`/`) shows the current pickup zone's
real surge multiplier via `GET /surge?lat=&lng=` before the rider ever submits.

## Mirroring core's real surge config, not inventing zone geometry

`GET /surge` returns each zone's `center` but not its radius — a zone's radius is what *defines*
the geohash precision server-side (`docs/surge-pricing.md`), not a per-zone response field. So
`frontend/src/constants.ts` adds `SURGE_ZONE_RADIUS_METERS` (2,000), `SURGE_MIN_MULTIPLIER` (1.0),
and `SURGE_MAX_MULTIPLIER` (3.0), mirroring `core/src/config.ts`'s real defaults — confirmed via
`docker exec ride-tracking-core-1 printenv` against the actual running container, not just read
off the docs. `infra/docker-compose.yml` hardcodes these (not `${VAR:-default}`), same as
`MATCH_OFFER_TIMEOUT_MS` in Frontend Phase 5 — a host env override would be silently ignored, so
these are the real values the packaged stack runs with, not just its documented defaults.

`SURGE_UPDATE_INTERVAL_MS` (15,000) is mirrored the same way and used as both the map overlay's
poll interval (`useSurgeZones.ts`) and the rider flow's pickup-zone poll interval
(`useSurgeAtPoint.ts`) — matching the real backend recompute cadence exactly (not just "the same
order of magnitude" loosely), same reasoning `useTripEta.ts` already established for
`ETA_RECOMPUTE_INTERVAL_MS`: every read in between is the exact same cached value
(`docs/surge-pricing.md`), so polling faster only wastes requests.

## Color is never the only signal

`surgeVisuals.ts` — a pure, independently unit-tested module (14 tests) — maps a multiplier to:

- `surgeFillColor`: pale amber (`rgb(253, 224, 71)`) at `SURGE_MIN_MULTIPLIER`, deepening to red
  (`rgb(185, 28, 28)`) at `SURGE_MAX_MULTIPLIER`, linearly interpolated in between.
- `surgeFillOpacity`: a second, independent intensity channel (0.2 → 0.7), purely additive.
- `formatMultiplier`: the one place a multiplier is ever formatted for display — one decimal place
  (e.g. `2.83` → `"2.8x"`), matching `docs/surge-pricing.md`'s own `"1.4x"` convention.

`SurgeOverlay.tsx` renders every zone as a `<Circle>` using these, with a **permanent** `<Tooltip>`
(not hover-only) showing `formatMultiplier(zone.multiplier)` directly on the map — a colorblind
viewer, or a plain black-and-white printout, gets the exact same information a sighted
color-viewer does, not a strictly-worse fallback.

## Where the overlay lives, and why the rider flow gets its own separate read

`SurgeOverlay` is mounted on `DriverMap.tsx` (the dispatcher's `/dispatcher` fleet map) — the one
general "live map" in this app, already polling/rendering live operational state. The rider
request flow (`TripRequestFlow.tsx`) is a distinct concern: it doesn't need the full zones list or
circle geometry, just "what will *my* pickup actually cost" — so it calls `GET /surge?lat=&lng=`
for the one specific pickup point via `useSurgeAtPoint.ts`, refetching immediately whenever pickup
changes (a new pickup is potentially a new zone) and otherwise on the same real poll interval.
Both paths ultimately read the exact same Redis-cached value (`docs/surge-pricing.md`'s
`getSurgeMultiplierForLocation`), so a rider's pre-submit quote and the eventual
`fareEstimate.surgeMultiplier` can only ever disagree if the zone's real multiplier changed
between the two reads — never because the two are computed differently.

## Verified live (real Docker containers, real `SURGE_UPDATE_INTERVAL_MS=15000`, real zones)

`infra/docker-compose.yml` hardcodes the same real surge config `core` actually runs
(`SURGE_ZONE_RADIUS_METERS=2000`, `SURGE_UPDATE_INTERVAL_MS=15000`, `SURGE_MIN_MULTIPLIER=1`,
`SURGE_MAX_MULTIPLIER=3`, `SURGE_MIN_SAMPLE_REQUESTS=3`, `SURGE_MAX_CHANGE_PER_INTERVAL=0.3`) —
confirmed via `docker exec ride-tracking-core-1 printenv`. Every check below used these real
values, no shortcuts.

### Criterion 1 — a real demand spike changes the map only after a real tick, not per-request

Following `docs/surge-pricing.md`'s own established technique, open trip requests were inserted
directly into Postgres (bypassing `POST /trips`/matching entirely, so the "requested" rows persist
as genuine unmatched demand rather than resolving in milliseconds — matching's own fast resolution
is real and correct, and is exactly why the docs' own live verification used this same direct-SQL
technique).

```
--- BEFORE insert: zone 20334512's real state ---
{'multiplier': 1, 'requestCount': 0, 'driverCount': 1}

t=08:57:48 — inserted 8 open trip requests (single batched statement) in zone 20334512

--- IMMEDIATELY AFTER insert: GET /surge (same updatedAt, same requestCount=0 — proves no
    per-request recompute happened) ---
{'multiplier': 1, 'requestCount': 0, 'driverCount': 1, 'updatedAt': '2026-08-05T08:57:43.031Z'}
```

A real browser then loaded `/dispatcher`:

```
=== T0: map's first real render, right after page load ===
real backend state: multiplier=1.3, requestCount=8, updatedAt=2026-08-05T08:57:58.034Z
on-screen labels present: [1.0x, 1.0x, 1.3x, 1.0x, ...] (baseline "1.0x" present: true)

=== Waiting one real SURGE_UPDATE_INTERVAL_MS tick (15s) for the backend to actually recompute ===

real backend state after the tick: multiplier=1.6, requestCount=8, updatedAt=2026-08-05T08:58:13.035Z
(08:58:13 - 08:57:58 = 15s, exactly one real interval)

=== Waiting for the frontend's own poll (same interval) to pick this up and re-render ===
on-screen labels now: [1.0x, 1.0x, 1.6x, 1.0x, ...]
the zone's new real multiplier ("1.6x") is now visible on the map: true
```

The zone's `updatedAt` moved by exactly one real 15-second interval between reads, its multiplier
moved by exactly one smoothing step (`SURGE_MAX_CHANGE_PER_INTERVAL = 0.3`), and the on-screen
label tracked it — confirming the overlay reflects the backend's real interval-based recompute,
not a per-request one.

### Criterion 2 — the rider flow's pre-submit multiplier matches the fareEstimate afterward

A real browser session on `/` placed a pickup pin precisely at a zone already confirmed (via a
sustained demand spike, converged over several real intervals) to be at the real
`MAX_MULTIPLIER` ceiling:

```
=== Pre-submit: real surge multiplier shown for this pickup zone ===
rider flow shows, before submitting: "3.0x"

=== Submitting the real trip ===
trip's real fareEstimate.surgeMultiplier, shown after submitting: "×3"

SIDE BY SIDE: pre-submit=3x, post-submit fareEstimate=3x, match: true
```

(Precisely placing the pickup pin used a 2-point real-click calibration — clicking two known
pixels, reading back Leaflet's actual resulting lat/lng from the picking panel each time, then
linearly solving for the pixel corresponding to the target coordinate; Web Mercator distortion
over this app's ~0.1°-wide bounding box is negligible, and the resulting placement landed within
about 5 meters of the intended point — comfortably inside the 2,000m zone radius.)

### Criterion 3 — the numeric label is legible and correct at both extremes

From the same live `/dispatcher` session, checked against the real `GET /surge` response at the
same moment:

```
real backend: zone 20334525 -> multiplier=3   (at the real MAX_MULTIPLIER ceiling)
real backend: zone 20334568 -> multiplier=1   (baseline — requestCount=1 < MIN_SAMPLE_REQUESTS=3)

on-screen labels include both "3.0x" and "1.0x": true
```

Both labels were read directly from the rendered DOM (`.surge-label` tooltip text), not eyeballed
— confirmed to exactly match the real API response's `multiplier` field, formatted to one decimal
place, at both the baseline zone and the zone genuinely converged to the real ceiling.

## Verifying it yourself

```
make up   # postgres, redis, core
cd frontend && npm run dev   # http://localhost:5173, http://localhost:5173/dispatcher

npm test          # includes surgeVisuals.test.ts (14 tests)
npm run typecheck
npm run lint
npm run build
```

To reproduce a real demand spike without waiting for organic load, insert `trips` rows directly
with `status = 'requested'` near an online driver (same technique `core/test/surge.test.ts` and
`docs/surge-pricing.md`'s own live verification use), then watch `/dispatcher` — the zone's color
and label will not move until a real `SURGE_UPDATE_INTERVAL_MS` tick elapses, confirmed by `GET
/surge`'s own `updatedAt` timestamp advancing by the same real interval.

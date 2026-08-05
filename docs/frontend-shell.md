# Frontend: Project Scaffolding & Responsive Shell (Frontend Phase 0)

`/frontend` — React + TypeScript + Vite, Tailwind CSS v4, react-router. Three placeholder routes
(rider, driver, dispatcher/admin map), a typed API client wrapping `core`'s real REST endpoints,
and a responsive app shell with a live backend-reachability indicator.

## Stack notes

- **React 19 / Vite 8 / TypeScript ~6.0**: `npm create vite@latest` pulled in the current stable
  versions of each at scaffold time. The default template it generates now ships a marketing
  landing page and `oxlint` instead of ESLint — both replaced (see below) since the brief
  specifically asked for ESLint + Prettier matching `core`'s conventions.
- **Tailwind CSS v4** via `@tailwindcss/vite` — no `tailwind.config.js` needed for this phase's
  scope (no custom theme yet); `src/index.css` is just `@import "tailwindcss";`.
- **ESLint + Prettier**: `eslint.config.js` mirrors `core/eslint.config.mjs`'s flat-config
  structure (`@eslint/js` recommended + `typescript-eslint` recommended + `eslint-config-prettier`
  last, so Prettier-conflicting stylistic rules are disabled rather than fighting Prettier),
  plus `eslint-plugin-react-hooks`/`eslint-plugin-react-refresh` for the React-specific rules
  `core` has no equivalent for. `.prettierrc.json`/`.prettierignore` are copied from `core`
  verbatim (same `semi`/`singleQuote`/`trailingComma`/`printWidth`).
- **`react-router-dom` pinned to an exact version (7.18.2), not a caret range**: `npm audit`
  flags every currently-published version (7.12.0 through 8.2.0, including the `latest` dist-tag)
  for a "RSC Mode CSRF Bypass" advisory. This app is a plain client-side SPA — it never uses
  React Server Components or server actions, the exact surface the advisory is about — so the
  vulnerability has no exploitable path here. Pinned exactly (rather than `^7.18.2`) so a future
  `npm install` doesn't silently drift to a different vulnerable version without a deliberate
  decision to do so.

## Typed API client

`src/api/types.ts` mirrors the real response/request shapes from `docs/API.md` and the real Zod
input schemas in `core/src/schemas/*.ts` (`DriverStatus`, `TripStatus`, `EtaSource`, etc. are
copied from the actual `as const` arrays/union types, not independently invented). `src/api/client.ts`
wraps every endpoint used so far (drivers, riders, trips, surge, health) behind a discriminated
`ApiResult<T>` — the same reusable typed-fallback pattern `core`'s own external clients use
(`ml-eta-client.ts`, `osrm-client.ts`): callers need to tell "the request never reached the
server" (`network_error` — offline, DNS failure, connection refused) apart from "the server
responded, just not with 2xx" (`api_error`, with the real `code`/`message` from `docs/API.md`'s
error shape) — collapsing both into one generic error would make it impossible for the UI to
show, say, "core is unreachable" vs. "that coordinate is out of range" with different messages.

## A real bug found by actually running a browser against it: no CORS support in `core`

The very first live check — opening the app in a real browser (via Playwright, not just curl)
against a running `core` — hung forever on "checking core…". `curl` had shown `/health` working
fine, which was the tell: a browser enforces same-origin policy for `fetch()`, `curl` doesn't.
`core` (`http://localhost:3000`) had no CORS headers at all, so every request from the frontend's
dev server (`http://localhost:5173` — a different origin, different port) was silently blocked by
the browser before it ever reached a route handler, regardless of anything the handler did.

**Fixed in `core`, not worked around in the frontend** (a `no-cors`/proxy workaround would have
hidden the real response instead of exposing it, which defeats the actual health-check reading and
also would have blocked the request/response shapes every other endpoint needs to actually read):
added `@fastify/cors`, registered before any route (`core/src/server.ts`), allowlisting origins
from a new `CORS_ORIGINS` config value (`core/src/config.ts`, comma-separated, default
`http://localhost:5173` — Vite's own default dev port, so `npm run dev` works against a locally
running `core` with zero extra config). An explicit allowlist, not `origin: true`/`"*"` — same
"reject/allowlist rather than open-ended wildcard" posture as this project's other boundary checks
(e.g. `NEARBY_MAX_RADIUS_METERS`). `core/test/cors.test.ts` (3 tests): an allowed origin gets
`Access-Control-Allow-Origin` echoed back; a non-allowlisted origin does not; a real CORS
preflight (`OPTIONS`) for a `POST` route succeeds with the right headers. Full suite: **201 tests
passing** (198 + 3 new).

## Responsive breakpoint: `sm` (640px), top nav vs. bottom tab bar

Chosen to be the exact same number the phase's own acceptance criteria uses for "phone width"
(`< 640px`) — so the breakpoint implemented is the same one the verification below tests against,
not an independently-picked number that happens to roughly line up. Below 640px: a compact header
(title + health indicator only) and a bottom tab bar (`Rider`/`Driver`/`Dispatcher`, icon + label,
full-width touch targets). At or above 640px: a single top header with an inline nav and the health
indicator on the same row, no bottom bar. Both navs use `NavLink`, which sets `aria-current="page"`
on the active route automatically, live inside a `<nav aria-label="Primary">` landmark, and get a
visible `focus-visible` outline for keyboard users (not just a mouse-hover style).

## Live health indicator

`src/components/HealthIndicator.tsx` calls `GET /health` on mount and every 10 seconds afterward
(`POLL_INTERVAL_MS`) — not a one-time check that goes stale if `core` drops mid-session. Renders
one of three real states (`checking…` / `core reachable (v...)` / `core unreachable`), inside a
`role="status" aria-live="polite"` region so a screen reader announces state changes.

## Verified live (real browser via Playwright, not eyeballed)

**Both breakpoints, `core` up** — screenshots captured against the actual running app:

| Phone (375px) | Desktop (1280px) |
| --- | --- |
| `docs/screenshots/phone-375.png` — bottom tab bar, compact header | `docs/screenshots/desktop-1280.png` — top nav, single header row |

Both show `core reachable (v0.1.0)` — the real version string from `core`'s own `/health` response,
not a hardcoded label.

**`core` stopped** (`docker compose stop core`): `docs/screenshots/desktop-1280-unreachable.png`
shows the real `core unreachable` state (red dot) — same page, no special-cased "offline" route.

**Recovery, same page instance, no reload** — confirmed with a real stop/start cycle:

```
confirmed unreachable (core still stopped): core unreachable
starting core...
recovered without reload after 9857ms: "core reachable (v0.1.0)"
```

~9.9s — matches the 10-second re-poll interval exactly (the indicator picked up the change on its
very next scheduled check), not a coincidence.

**Typecheck/lint**: `npm run typecheck` (`tsc -b --noEmit`) and `npm run lint` (`eslint .`) both
pass clean, `npm run build` produces a real production bundle (`vite build`, 233KB JS / 74.7KB
gzipped, 169ms).

## Verifying it yourself

```
make up                       # postgres, redis, core, ml-service (repo root)
cd frontend
cp .env.example .env          # if not already present
npm install
npm run dev                   # http://localhost:5173

npm run typecheck
npm run lint
npm run build

cd ../core && npm test        # includes test/cors.test.ts (3 tests)
```

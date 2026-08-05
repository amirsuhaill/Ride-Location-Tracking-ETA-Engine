# Frontend: Build, Deploy, and the Build-Time-vs-Runtime Gotcha (Frontend Phase 10)

The wrap-up phase: produce a real production build, decide how it's actually served, resolve the
build-time-vs-runtime env var problem Phase 0 flagged and deferred, wire it into `make up`, and
prove all of it live against a genuinely fresh Docker volume — not just in dev.

## Decision 1: folded into `core`'s own Fastify instance, not a separate container

**Chosen: `core` serves the frontend's built static assets itself**, via `@fastify/static`
(`core/src/routes/frontend.ts`), not a second `nginx`/`caddy` container in docker-compose.

Why, compared to the alternative:

- **Same-origin by construction.** Serving the SPA from the same Fastify instance that serves the
  API and WebSocket routes means the browser's own requests are same-origin in the default
  deployment — CORS isn't a concern on that path at all (it only re-enters the picture for the
  deliberate "second environment" scenario below, which is a real cross-origin case by design).
- **No new deployment surface.** A handful of static files (currently ~460KB total, see "Real,
  current build numbers" below) doesn't justify a new image, a new compose service, a new
  health-check, or a new port to reason about — `core`'s image already exists and already has a
  working multi-stage Docker build convention to extend.
- **Reuses an existing project convention**, not a new one: `core` already registers
  `@fastify/cors` and `@fastify/websocket` as plugins in `server.ts`; `@fastify/static` slots into
  exactly the same pattern.

The real tradeoff this gives up: `core`'s own image gets bigger and a frontend-only change now
requires rebuilding `core`'s image too (no independent frontend deploy/rollback). Judged
acceptable — this is a single-team, single-deploy-unit project (see `README.md`'s own framing),
not a system where the frontend and backend ship on independent cadences.

## Decision 2: a runtime-config shim, not build-time-baked `VITE_*` vars

This is Phase 0's own deferred gotcha (see `PROMPTS.md`): Vite bakes `VITE_`-prefixed env vars
into the JS bundle at `vite build` time. A container's env vars at `docker run`/`compose up` time
are invisible to already-built, already-bundled JS — setting `CORE_API_URL` differently in a
second environment's compose file would have **no effect at all** on a frontend image built once
and reused, unless something is actually done about it.

**Chosen: a runtime-config shim.** `core` now generates `/runtime-config.js`
(`core/src/routes/frontend.ts`) — plain, uncompiled JS, generated fresh per request:

```js
window.__RUNTIME_CONFIG__ = {"coreApiUrl": "...", "coreWsUrl": "..."};
```

`frontend/index.html` loads this via a plain `<script src="/runtime-config.js">` tag placed
*before* the deferred `<script type="module" src="/src/main.tsx">` tag:

```html
<script src="/runtime-config.js"></script>
<script type="module" src="/src/main.tsx"></script>
```

This ordering is load-bearing, not cosmetic: a plain (non-module) script executes immediately as
it's parsed, while a `type="module"` script is always deferred until the full document has parsed
— so `window.__RUNTIME_CONFIG__` is guaranteed to exist before `main.tsx` (or `src/config.ts`,
transitively) ever runs, regardless of Vite's own tendency to hoist the module tag into `<head>`
at build time.

`frontend/src/config.ts` prefers `window.__RUNTIME_CONFIG__` when present, and only falls back to
Vite's build-time `import.meta.env.VITE_CORE_API_URL`/`VITE_CORE_WS_URL` when it isn't (i.e.
plain `npm run dev` / `vite preview`, where no server generates that route):

```ts
function resolveConfig(): RuntimeConfig {
  if (window.__RUNTIME_CONFIG__) return window.__RUNTIME_CONFIG__;
  return {
    coreApiUrl: requireEnv("VITE_CORE_API_URL"),
    coreWsUrl: requireEnv("VITE_CORE_WS_URL"),
  };
}
```

`core/Dockerfile`'s frontend-build stage deliberately sets **obviously-fake** `VITE_CORE_API_URL`/
`VITE_CORE_WS_URL` values (`http://build-time-value-should-never-be-used.invalid`) rather than a
plausible-looking default — if the runtime-config wiring is ever broken by a future change, the
app fails loudly (invalid URL in the network tab) instead of silently working by coincidence.

`core`'s own new config (`core/src/config.ts`):

```ts
publicCoreApiUrl: process.env.PUBLIC_CORE_API_URL ?? "",
publicCoreWsUrl: process.env.PUBLIC_CORE_WS_URL ?? "",
```

Both default to empty. When empty, `/runtime-config.js` derives the URLs from the **real incoming
request's own `Host` header** (`core/src/routes/frontend.ts`):

```ts
const coreApiUrl = frontendConfig.publicCoreApiUrl || `${request.protocol}://${host}`;
const coreWsUrl =
  frontendConfig.publicCoreWsUrl || `${request.protocol === "https" ? "wss" : "ws"}://${host}`;
```

This gives zero-config correctness for the default same-origin deployment (whatever host/port a
browser used to reach `core` is exactly what the frontend should call back), while the two
`PUBLIC_CORE_*` env vars remain available to override it explicitly — the exact mechanism a real
second environment (or the cross-origin test below) uses to point the *same built image* at a
different backend, with no rebuild.

## Wired into `make up` — zero new steps

`infra/docker-compose.yml`'s `core` service build context changed from `../core` to the repo root
(`..`), with `dockerfile: core/Dockerfile` specified explicitly — the Dockerfile's frontend-build
stage needs `COPY frontend/...` access, which a `core`-only build context can't provide. A new
root-level `.dockerignore` was added for this (Docker only reads a `.dockerignore` from the build
context root — the pre-existing `core/.dockerignore`/`ml-service/.dockerignore` don't apply to a
repo-root context).

No new Makefile target exists on purpose — `make up` already builds and starts `core`, and
`core`'s image now bakes in the frontend build as part of that same `docker build`. The Makefile
carries a comment explaining this explicitly rather than leaving it implicit (see `Makefile`).

## A real, previously-undocumented gap found while verifying a genuinely fresh volume

Proving "`make up` serves a working frontend end-to-end... verified live in a fresh
`docker compose down -v && make up`" required actually running that exact command, not assuming
it would work because a warm volume already worked. It didn't, the first time:

```
$ docker compose -f infra/docker-compose.yml down -v && make up-d
...
{"level":50,...,"err":{"message":"relation \"trips\" does not exist"},...}
```

**Root cause**: nothing in this project — not `docker-compose.yml`, not the old `core/Dockerfile`,
not `README.md` — ever ran database migrations automatically. Every previous phase's own live
verification happened to reuse an already-migrated Postgres volume from earlier manual
`npm run migrate:up` runs during development, masking this gap entirely until Phase 10 asked for a
truly fresh one.

**Fixed** with `core/docker-entrypoint.sh`, now `core`'s image `CMD`:

```sh
echo "Running database migrations..."
i=1
until npm run migrate:up; do
  if [ "$i" -ge 10 ]; then
    echo "migrate:up did not succeed after $i attempts" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done
exec node dist/index.js
```

The retry loop mirrors `core/scripts/test.sh`'s own established pattern for the same real
postgres/PostGIS race (the image restarts its process internally after running its own
`docker-entrypoint-initdb.d` scripts, so the very first migration attempt on a truly fresh volume
can hit a connection reset/refusal before the real instance is back). `node-pg-migrate` tracks
already-applied migrations in its own table, so re-running this on every container start against
an already-migrated database is a safe no-op — confirmed by the second fresh run below completing
with `No migrations to run!`.

**Re-verified, a second genuinely fresh volume, full transcript**:

```
$ docker compose -f infra/docker-compose.yml down -v
$ make up-d
...
$ docker logs ride-tracking-core-1
Running database migrations...

> core@0.1.0 migrate:up
> node-pg-migrate up

Error: connect ECONNREFUSED 172.x.x.x:5432          # same real postgres-restart race, retried
> Migrating files:
> - 1735700001000_enable-postgis
> - 1735700002000_create-status-enums
> - 1735700003000_create-drivers
... (7 files total)
Migrations complete!
{"level":30,...,"path":"/app/public","msg":"serving frontend static assets"}
{"level":30,...,"msg":"Server listening at http://127.0.0.1:3000"}

$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
200
$ curl -s http://localhost:3000/runtime-config.js
window.__RUNTIME_CONFIG__ = {"coreApiUrl":"http://localhost:3000","coreWsUrl":"ws://localhost:3000"};
```

## Verified live: map loads, a real trip is requested and tracked

The acceptance criterion's exact wording — "map loads, a real trip can be requested and
tracked" — checked with this project's own established real-browser convention (Phase 9's
`e2e/trip-request.spec.ts` + `e2e/fakeDriverClient.ts`: a real Playwright browser, a real scripted
driver over a real `ws` connection, a real running `core`), pointed at the actual
Docker-composed stack instead of the Vite dev server:

```
$ cd frontend
$ E2E_APP_URL=http://localhost:3000 E2E_CORE_URL=http://localhost:3000 \
  E2E_CORE_WS_URL=ws://localhost:3000 npx playwright test

Running 1 test using 1 worker
  ✓  1 e2e/trip-request.spec.ts:22:3 › real rider request end to end › a rider's request is
     matched by a real driver client, and the driver marker live-updates (4.5s)
  1 passed (5.4s)
```

This is a real browser loading real bundled JS/CSS from `core`'s own static-file route, placing
pickup/dropoff on a real Leaflet map, submitting a real `POST /trips`, getting matched by a real
scripted driver client, and observing the driver marker live-update from a real subsequent
WebSocket broadcast — all served by the exact container image `make up` produces. Screenshot:
`docs/screenshots/phase10-served-by-core.png` (captured at `http://localhost:3000/`, not
`localhost:5173`).

## Verified live: the same built image points at a genuinely different backend

The acceptance criterion's second, distinct claim — "pointing the built frontend at a different
`CORE_API_URL` than the one it was built against actually works" — needs *two* real backends, not
one, to be a real test. Reproduced with the actual `ride-tracking-core:latest` image
`make up` already builds, run twice:

**Container A** (`ride-tracking-core-1`, the normal `make up` container, port 3000) — CORS
allowlist widened for this test only:

```
# infra/.env
CORS_ORIGINS=http://localhost:5173,http://localhost:3001
```

**Container B** — the *same image*, no rebuild, a different container, port 3001, its runtime
config pointed back at container A:

```
$ docker run -d --name ride-tracking-core-2 \
    --network ride-tracking_ride-tracking-net -p 3001:3000 \
    -e DATABASE_URL="postgres://ridetracking:ridetracking@postgres:5432/ridetracking" \
    -e REDIS_URL="redis://redis:6379" -e ML_SERVICE_URL="http://ml-service:8000" \
    -e CORS_ORIGINS="http://localhost:3001" \
    -e PUBLIC_CORE_API_URL="http://localhost:3000" \
    -e PUBLIC_CORE_WS_URL="ws://localhost:3000" \
    ride-tracking-core:latest

$ curl -s http://localhost:3001/runtime-config.js
window.__RUNTIME_CONFIG__ = {"coreApiUrl":"http://localhost:3000","coreWsUrl":"ws://localhost:3000"};
```

Container B serves the identical static bundle (same image, same JS/CSS files — confirmed by
`GET http://localhost:3001/` returning 200 with the same asset filenames as container A), but its
generated `/runtime-config.js` points at container A's origin, not its own. This is only possible
because the config is resolved at request time by whichever container serves it, never baked into
the shared JS bundle — proving decision 2 above is real, not just discussed.

**CORS, checked explicitly, not assumed**: a browser loading the app from container B's origin
(`http://localhost:3001`) making a cross-origin call to container A (`http://localhost:3000`) is a
genuine cross-origin request. A raw preflight against container A confirms it's allowed:

```
$ curl -s -i -X OPTIONS http://localhost:3000/drivers \
    -H "Origin: http://localhost:3001" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: content-type"
HTTP/1.1 204 No Content
access-control-allow-origin: http://localhost:3001
access-control-allow-methods: GET, POST, PATCH
access-control-allow-headers: content-type
```

And the same real Phase 9 e2e suite, this time pointed at container B's served frontend while its
own JS talks to container A's API/WS — i.e. a real browser genuinely doing cross-origin HTTP +
WebSocket calls throughout the whole trip-request/match/track flow:

```
$ E2E_APP_URL=http://localhost:3001 E2E_CORE_URL=http://localhost:3000 \
  E2E_CORE_WS_URL=ws://localhost:3000 npx playwright test

Running 1 test using 1 worker
  ✓  1 e2e/trip-request.spec.ts:22:3 › ... (3.8s)
  1 passed (4.6s)
```

If CORS were misconfigured for this origin, the browser would block every cross-origin response
and this test would time out waiting for the "matched" UI state — it didn't, in 3.8s. This is the
real, load-bearing proof, not the curl preflight alone.

**Operational note for a real second environment**: the backend a second frontend origin talks to
must include that frontend's own serving origin in *its* `CORS_ORIGINS` (comma-separated, see
`infra/.env.example`) — this is the one manual step a genuinely different-origin deployment
requires, and is now documented rather than discovered by a failed deploy.

Container B and the widened `CORS_ORIGINS` were both torn down after this test; `infra/.env`'s
`CORS_ORIGINS` is back to its normal single-origin default.

## Real, current build numbers (traceable, not placeholders)

```
$ cd frontend && npm run build
dist/index.html                   1.22 kB │ gzip:  0.75 kB
dist/assets/index-*.css          30.72 kB │ gzip: 10.32 kB
dist/assets/index-*.js          429.14 kB │ gzip: 131.05 kB
```

(A `<script src="/runtime-config.js"> ... can't be bundled without type="module"` warning is
expected and correct here — it confirms Vite leaves that reference external rather than inlining
it, which is required: it must stay a live server route, not a build artifact.)

Reproduce end to end:

```
docker compose -f infra/docker-compose.yml down -v
make up
# in a second terminal, once core is healthy:
curl http://localhost:3000/
curl http://localhost:3000/runtime-config.js
cd frontend && npx playwright test   # E2E_APP_URL/E2E_CORE_URL/E2E_CORE_WS_URL=http://localhost:3000
                                      # (see playwright.config.ts's own doc comment)
```

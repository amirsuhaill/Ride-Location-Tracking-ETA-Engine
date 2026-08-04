# ML ETA Integration into Core (Phase 10)

Wires `GET /trips/:id/eta` to call ml-service's trained model (Phase 9) instead of — or alongside,
as a fallback for — Phase 7's haversine + rush-hour heuristic. Toggleable via config, with no
redeploy needed to switch between them.

## `ETA_MODE`: heuristic | ml | ml_with_fallback

One env var (`ETA_MODE`, default **`heuristic`**), read into `config.ts`'s `EtaMode` and threaded
through `eta-config.ts`'s existing per-test-overridable runtime config — no new plumbing needed
beyond that, since `buildServer({eta: {...}})` already supported arbitrary `EtaRuntimeConfig`
overrides from Phase 7.

| Mode | Behavior |
| --- | --- |
| `heuristic` | Never calls ml-service. Identical to Phase 7. **Default** — a bare `npm start` or the test suite behaves exactly as before Phase 10, unless explicitly configured otherwise. |
| `ml` | Calls ml-service only. **No fallback** — on any failure, the response is flagged with a distinct `ml_unavailable` status rather than silently substituting a heuristic number. Meant for demoing/evaluating the model in isolation, where masking a failure with the heuristic would defeat the point of the comparison. |
| `ml_with_fallback` | Calls ml-service first; on any failure (unreachable, timeout, or a malformed/error response), immediately computes a fresh heuristic estimate instead. The production-shaped mode. |

The packaged Docker demo (`infra/docker-compose.yml`) defaults `core`'s `ETA_MODE` to
`ml_with_fallback` (overridable via `infra/.env` without editing the compose file) specifically so
the stack showcases the full Phase 9+10 integration out of the box — while the *library* default
(`core/.env.example`, and what a plain `npm start`/the test suite gets with no override) stays
`heuristic`, preserving Phase 7's exact behavior unless a caller opts in. `core` deliberately does
**not** `depends_on` `ml-service` in docker-compose — it's designed to start and serve ETAs fine
even if ml-service never comes up at all, which is the whole point of the fallback.

## Why `mode="ml"` gets its own status instead of silently degrading

`GET /trips/:id/eta` already has a philosophy (`docs/eta.md`): every case is a distinct, honest
answer, never a crash or a silently-wrong number. Phase 10 extends that with `ml_unavailable`:
when `mode="ml"` and a fresh ML attempt fails, the response is flagged with that status — carrying
the *last known* value if one was ever cached (same "stale but present, clearly flagged" pattern
as `stale_location`), or `null` if nothing has ever been computed. `mode="ml_with_fallback"` never
produces this status: a successful fallback is a full, if differently-sourced, success — the
heuristic never actually fails (it's a pure local calculation), so there's always a fresh number
to show, just tagged `ml_fallback` instead of `ml`.

## Reusing, not duplicating, Phase 7's throttle for the ML cache

The prompt's "cache predictions briefly, a few seconds, so rapid location updates don't hammer the
ML service" is implemented as a **new threshold value plugged into the exact same throttle
function** (`eta.service.ts#maybeRecomputeEta`), not a second parallel cache mechanism:

```
recomputeIntervalMs = mode === "heuristic" ? ETA_RECOMPUTE_INTERVAL_MS (15s) : ETA_ML_CACHE_TTL_MS (5s, new)
shouldRecompute = no cached value yet
                  OR time since last compute >= recomputeIntervalMs
                  OR driver moved >= ETA_RECOMPUTE_DISTANCE_METERS (200m, unchanged, shared across modes)
```

Same "time elapsed OR distance moved, whichever first" gate as Phase 7 — just a shorter default
time threshold when the engine in play is a network call worth protecting (5s) versus a free local
calculation that doesn't need the same protection (15s). The distance threshold is shared
unchanged across every mode: a driver who's moved meaningfully deserves a fresh number regardless
of which engine computes it.

**Verified live** (`test/eta-ml-fallback.test.ts`, "ML cache TTL throttles repeated ML calls"): a
counting stub confirms exactly one ML call for two rapid requests within the TTL, a second call
triggered by a >200m move even before the TTL elapses, and a third call once the TTL elapses with
no movement at all.

## Observability: response body, headers, and logs

Every `GET /trips/:id/eta` response carries:

- `etaSource`: `"heuristic" | "ml" | "ml_fallback" | null` — which engine produced the currently-
  shown number (null only if nothing has ever been computed for this trip).
- `servedFromCache`: `boolean | null` — whether *this specific call* triggered a fresh computation
  (`false`) or just returned the already-cached value untouched (`true`); `null` alongside
  `etaSource === null`.

...and the same information is mirrored on response **headers** (`X-ETA-Source`, `X-ETA-Cache:
hit|miss|n/a`) — so a demo/comparison can just `curl -i` the endpoint and see which path served it
without parsing JSON.

**Failures are logged** (`console.warn`, the same convention already used by non-request-context
service code elsewhere in this codebase — `reconciliation.service.ts`, `ws/location-batch.ts`):

```
ml-service predict-eta failed (unreachable): fetch failed — falling back to heuristic for trip <id>
ml-service predict-eta failed (unreachable): fetch failed — no fallback configured (mode=ml) for trip <id>
```

Successful responses are *not* individually logged — they're already fully observable via the
body/header fields on every single response, and logging every success too (especially under
frequent polling) would just be noise for no benefit.

## The three ML failure modes — distinguished, not lumped together

`src/services/ml-eta-client.ts#fetchMlEta` returns a discriminated result with one of four
outcomes: `ok`, or a failure tagged `unreachable` | `timeout` | `error_status` |
`malformed_response`. Each failure path is independently reachable and independently tested:

| Failure | How it's produced | How it's detected |
| --- | --- | --- |
| **Unreachable** | `fetch()` throws something other than an `AbortError` (connection refused, DNS failure). | `reason: "unreachable"`. |
| **Timeout** (slow) | An `AbortController` aborts the request after `ETA_ML_TIMEOUT_MS` (default **200ms**, configurable) — a genuine cancellation, not a polling check. | `reason: "timeout"`. |
| **Error status** | ml-service responds with a non-2xx status. | `reason: "error_status"`. |
| **Malformed response** | ml-service responds 200 but the body isn't valid JSON, or doesn't have the expected `predicted_duration_seconds`/`distance_meters`/`model_version` shape (wrong types, negative/non-finite numbers, empty version string). | `reason: "malformed_response"`. |

### Tested against a real local HTTP server, not a mocked `fetch`

`test/helpers/ml-stub-server.ts` spins up a genuine `node:http` server on an ephemeral port for
each test, with handlers for each scenario (`mlOkHandler`, `mlSlowHandler`, `mlErrorStatusHandler`,
`mlMalformedHandler`) — the same "real infrastructure over mocks" standard this project has used
throughout (real Postgres/Redis in every other integration test). This matters specifically for
the timeout case: a mocked `fetch` that just resolves after a delay wouldn't exercise genuine
`AbortController`-driven request cancellation over a real socket the way an actually-slow server
does. "Unreachable" is produced by starting a stub, grabbing its URL, then closing it before the
request — a real connection-refused, not a simulated one.

**Verified with an explicit elapsed-time assertion, not just "eventually passed"**
(`test/eta-ml-fallback.test.ts`): the slow-server test's stub takes 2000ms to respond while
`ETA_ML_TIMEOUT_MS` is set to 150ms — the test asserts the whole call took well under 1000ms,
proving the request was actually aborted around ~150ms rather than silently waited out.

**Verified live, against the real containers** (not just the stub-based tests): stopped the real
`ml-service` Docker container mid-session and hit `/trips/:id/eta` — got a genuine
`unreachable`-flagged fallback (`ml-service predict-eta failed (unreachable): fetch failed —
falling back to heuristic for trip ...`), then restarted `ml-service` and confirmed the very next
recompute went straight back to `etaSource: "ml"`. See "Verifying it yourself" below for the full
transcript.

## Mode toggle changes real behavior — verified against the same trip

`test/eta-ml-fallback.test.ts`, "ETA_MODE toggle changes observable behavior for the same trip":
hits `getTripEta` for one identical trip/driver-location three times, changing only
`configureEta({mode: ...})` between calls, against a stub that always returns a fixed, distinctive
ETA (777s):

- `mode: "heuristic"` → `etaSource: "heuristic"`, a haversine-derived number — **not** 777.
- `mode: "ml"` → `etaSource: "ml"`, exactly **777** (the stub's value, proving it's genuinely
  reaching the configured engine).
- `mode: "ml_with_fallback"` → `etaSource: "ml"` (ML is healthy, so no fallback triggers), 777.

Confirmed live too — restarting `core` locally with `ETA_MODE=heuristic` against a *healthy*
`ml-service` produced `etaSource: "heuristic"` with a haversine-derived number, proving heuristic
mode never even attempts an ML call regardless of ml-service's availability.

## Verifying it yourself

```
cd core
npm test   # includes test/eta-ml-fallback.test.ts — 9 tests: 4 failure-mode + 2 mode=ml + 1
           # mode-toggle + 1 throttle + 1 HTTP-header test
```

**Real captured live-verification transcript** (Docker Postgres + Redis + ml-service, `core` run
locally against them since this environment's Docker image build required network access that
wasn't available at verification time — still real containers end-to-end on the ml-service/DB
side, real HTTP calls from `core`, nothing stubbed):

```
$ curl http://localhost:8000/health
{"status":"ok", ..., "eta_model_loaded": true, "eta_model_version": "20260804T062150341857Z"}

# ETA_MODE=ml_with_fallback, ml-service healthy:
$ curl -i http://localhost:3000/trips/<id>/eta
X-ETA-Source: ml
X-ETA-Cache: miss
{"status":"ok","etaSeconds":294.98,"distanceMeters":1417.33,"etaSource":"ml","servedFromCache":false}

# immediately again (within the 5s ML cache TTL):
X-ETA-Source: ml
X-ETA-Cache: hit                              # same computedAt as the previous call

# docker compose stop ml-service, then move the driver (forces a fresh recompute attempt):
X-ETA-Source: ml_fallback
{"status":"ok","etaSeconds":299.11,"etaSource":"ml_fallback","servedFromCache":false}
# core log: "ml-service predict-eta failed (unreachable): fetch failed — falling back to
# heuristic for trip ..."

# docker compose start ml-service, wait for healthy, move the driver again:
X-ETA-Source: ml
{"status":"ok","etaSeconds":531.04,"etaSource":"ml","servedFromCache":false}   # recovered

# restart core with ETA_MODE=heuristic, ml-service still healthy:
X-ETA-Source: heuristic
{"status":"ok","etaSeconds":348.94,"etaSource":"heuristic", ...}              # ML never touched

# restart core with ETA_MODE=ml (no fallback), ml-service stopped, move the driver again:
X-ETA-Source: heuristic                        # <- provenance of the STALE cached value, honest
X-ETA-Cache: hit
{"status":"ml_unavailable","etaSeconds":348.94,"etaSource":"heuristic","servedFromCache":true}
# core log: "ml-service predict-eta failed (unreachable): fetch failed — no fallback configured
# (mode=ml) for trip ..."
```

That last line is worth calling out: `etaSource` reports who actually produced the number
currently being shown (here, an earlier heuristic-mode call, from before this trip's `ETA_MODE`
was switched mid-demo) — `status: "ml_unavailable"` is the honest signal that *this specific call's*
configured engine (ML) failed with no fallback, not a claim about where the stale number came from.

All containers/local processes were torn down after this check.

## Tests

- `test/eta-ml-fallback.test.ts`:
  - Three failure-mode tests (unreachable, slow/timeout, malformed) plus a fourth (error status)
    under `mode: "ml_with_fallback"` — each asserts `status: "ok"`, `etaSource: "ml_fallback"`,
    and a real positive `etaSeconds`.
  - Two tests under `mode: "ml"` (no fallback): failure with nothing cached →
    `ml_unavailable`/`null`; failure with a prior successful ML value cached → `ml_unavailable`
    but the stale ML number degrades through rather than being replaced by a fresh heuristic one.
  - One test proving the `ETA_MODE` toggle changes real behavior for an identical request.
  - One test proving the ML cache TTL throttle (reused Phase 7 mechanism, new threshold) behaves
    correctly under a counting stub.
  - One HTTP-level test asserting `X-ETA-Source`/`X-ETA-Cache` headers match the response body.
- `test/eta.service.test.ts` (Phase 7): every `configureEta` call now sets `mode: "heuristic"`
  explicitly — `configureEta` merges into a shared module-level singleton, so without this a
  leftover `mode`/`mlServiceUrl` from a differently-ordered test file could silently change these
  tests' behavior. Making every file's assumptions explicit, rather than relying on whichever file
  happens to run first, is the actual fix — not file-ordering hacks.

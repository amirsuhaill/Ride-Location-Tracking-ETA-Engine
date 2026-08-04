# Observability: Structured Logging & Metrics (Phase 16)

Two gaps closed in this final pass: **inconsistent logging** (Fastify's own request logs were
already structured JSON, but every non-request-context module — reconciliation, matching, eta,
surge, the WS batch/heartbeat loops — logged via plain `console.error`/`console.warn`/`console.log`
strings; ml-service had no structured logging at all, just uvicorn's default plain-text access
log) and **numbers frozen in docs** (Phase 5's bandwidth savings and Phase 11's throughput/latency
figures existed only as one-off captured transcripts in `docs/ws-batching-and-compression.md` and
`docs/load-testing.md` — real, but not something you could query from a running system).

## Structured logging

### core

`src/logger.ts` — a `pino({level: config.logLevel})` instance used by every background/service
module that used to call `console.*`: `reconciliation.service.ts`, `surge.service.ts`,
`eta.service.ts`, `ws/location-batch.ts`, `ws/driver-connections.ts`, `ws/runtime-config.ts`,
`routes/ws.ts`. Fastify's own request logging (`plugins/request-logging.ts`) already used pino
internally — configured with the identical `{level: config.logLevel}` options, so both emit the
same structured shape (`level`/`time`/`pid`/`hostname`/`msg`) even though they're two separate pino
instances rather than one shared object reference (Fastify 5's `loggerInstance` option has a
pino-version type incompatibility with this project's `FastifyInstance` generic — not worth
fighting for a cosmetic single-object win over an already-consistent output shape).

### ml-service

`app/logger.py` — a `JsonFormatter` matching the same minimal vocabulary (`time` as epoch
milliseconds, `level`, `msg`) plus the exact same camelCase field names core uses for request
logging (`method`, `path`, `statusCode`, `latencyMs` — see `app/main.py`'s `log_requests`
middleware) specifically so a combined log stream from both services reads consistently. `level`
is a lowercase string ("info"/"warning"/"error"), not pino's numeric levels — forcing Python's
logging ecosystem to speak Node's numeric protocol would fight standard practice for no real
benefit; `time` being epoch-ms either way is what actually matters for cross-service correlation
and sort order. uvicorn's own plain-text access log is disabled (`--no-access-log`, see
`Dockerfile`) in favor of this one structured line per request — the same "exactly one log line
per request" convention as core, not two differently-shaped ones.

**Verified live** (real Docker containers, not just the unit tests below):

```
$ curl http://localhost:8000/health
$ curl -X POST http://localhost:8000/predict-eta -d '{...}'
$ docker compose logs ml-service --tail=15
{"level": "info", "time": 1785870009888, "msg": "Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)", "logger": "uvicorn.error"}
{"level": "info", "time": 1785870012320, "msg": "request completed", "logger": "ml-service", "method": "GET", "path": "/health", "statusCode": 200, "latencyMs": 1.41}
{"level": "info", "time": 1785870024993, "msg": "request completed", "logger": "ml-service", "method": "POST", "path": "/predict-eta", "statusCode": 200, "latencyMs": 90.97}
```

And core's own request logs, same shape, same session:

```
{"level":30,"time":1785869515403,"pid":1,"hostname":"7ee9c1a5965a","reqId":"req-4","req":{"method":"GET","url":"/health",...},"msg":"incoming request"}
{"level":30,"time":1785869515406,"pid":1,"hostname":"7ee9c1a5965a","reqId":"req-4","method":"GET","path":"/health","statusCode":200,"latencyMs":2.59,"msg":"request completed"}
```

(core's `level` is pino's numeric convention — 30 = info — while ml-service's is the string
`"info"`; both carry `time`/`msg` in the same shape and both are one-line-per-request JSON, which
is the property that actually matters for a combined log stream.)

### Tests

- `core`: no test asserted on the old `console.*` string output (confirmed by grep before
  changing anything), so nothing needed updating beyond the log calls themselves; `npm test`'s
  full 198-test suite (below) passes unchanged.
- `ml-service`: `tests/test_logger.py` — the `JsonFormatter` produces valid JSON with the expected
  fields for a plain record, merges `extra={"fields": {...}}` into the payload, lowercases the
  level name, and — the integration case — a *real* request through the *real* FastAPI middleware
  (via `TestClient`, captured with pytest's `caplog`) emits exactly one `"request completed"`
  record with the correct `method`/`path`/`statusCode`/`latencyMs` fields.

## Prometheus metrics: `GET /internal/metrics/prometheus`

`src/metrics/registry.ts` defines a `prom-client` `Registry` plus:

- `location_updates_processed_total` (Counter) — incremented once per `enqueueLocationUpdate` call
  (`ws/location-batch.ts`), i.e. once per post-throttle location update. This is the numerator
  Prometheus's own `rate()` function turns into the exact "updates/sec" figure
  `docs/load-testing.md` computed by hand from the load generator's own counters.
- `location_broadcast_latency_seconds` (Histogram) — observed once per broadcast
  (`ws/location-batch.ts#flushBatch`), `Date.now() - update.timestamp`: the same "added latency"
  Phase 5/11 measured client-side, now server-side and continuously queryable.
- `trip_matching_latency_seconds` (Histogram) — observed in `matching.service.ts#matchTrip`'s
  `finally` block (covers every terminal outcome: matched, no_drivers_available,
  all_candidates_declined — not `already_resolved`, which isn't a real matching attempt).

`src/routes/metrics.ts` additionally registers `Gauge`s (event loop lag percentiles, Postgres pool
state, WS fleet sizes, and Phase 5's bandwidth totals/savings-percent) with a `collect()` hook that
reads this project's existing live-state getters at scrape time — the exact same functions the
pre-existing `GET /internal/metrics` JSON endpoint already used, so both endpoints report identical
underlying numbers in two different formats. These gauges are defined in `routes/metrics.ts` rather
than `metrics/registry.ts` specifically to avoid a circular import: `location-batch.ts` and
`matching.service.ts` import the Counter/Histogram objects *from* `registry.ts` to record into, so
`registry.ts` itself imports nothing from either module.

### Tests

`core/test/metrics-prometheus.test.ts` — 4 tests: every declared metric name's `# HELP`/`# TYPE`
lines are present; `location_updates_processed_total` increases by exactly the number of real
`enqueueLocationUpdate` calls made (not "some" — an exact diff assertion); a real `flushBatch()`
records exactly one `location_broadcast_latency_seconds` observation; a real `matchTrip()` call
(the fast `no_drivers_available` path — no WS driver connection needed) records exactly one
`trip_matching_latency_seconds` observation.

### Verified live — the new counters match the load test's own client-side numbers exactly

Brought up real `postgres`/`redis`/`core` via `docker compose`, ran a small real WebSocket driver
fleet (`npm run load-test:fleet`, 20 drivers, 500ms interval, 6s), then scraped the live endpoint:

```
$ DRIVER_COUNT=20 DURATION_MS=6000 SEND_INTERVAL_MS=500 npm run load-test:fleet
...
Sampled broadcasts observed:                 121
Bandwidth savings:                           23.8%

$ curl -s http://localhost:3000/internal/metrics/prometheus | grep -E \
    "^location_updates_processed_total|^location_broadcast_latency_seconds_count|^ws_bandwidth_bytes"
location_updates_processed_total 121
location_broadcast_latency_seconds_count 121
ws_bandwidth_bytes{kind="messages_sent"} 121
ws_bandwidth_bytes{kind="savings_percent"} 23.81266156419484
```

The server-side Prometheus counter (`121`) matches the load generator's own independently-computed
client-side count (`121`) exactly, and the live `savings_percent` gauge (23.81%) matches the load
generator's own bandwidth-savings calculation (23.8%, rounding) — two independently-computed
numbers agreeing is a real correctness signal, not just "the endpoint returns 200."

## Verifying it yourself

```
cd core && npm test              # includes test/metrics-prometheus.test.ts (4 tests)
cd ml-service && pytest          # includes tests/test_logger.py (4 tests)

docker compose -f infra/docker-compose.yml up -d postgres redis core ml-service
curl http://localhost:3000/internal/metrics/prometheus
curl http://localhost:8000/health   # then check `docker compose logs ml-service` for structured JSON
```

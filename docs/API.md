# REST API (Phase 2)

Base URL: `http://localhost:3000` (or `http://core:3000` from inside the Docker network).

## Error shape

Every error response — validation failure, missing entity, illegal state transition, or
unexpected crash — uses this one shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "lat must be between -90 and 90" } }
```

| HTTP status | `code`             | Meaning                                                   |
| ----------- | ------------------ | ---------------------------------------------------------- |
| 400         | `VALIDATION_ERROR`  | Request body/params failed validation (missing field, bad type, out-of-range coordinate, invalid enum value, malformed UUID). |
| 404         | `NOT_FOUND`         | The referenced entity (or route) doesn't exist.            |
| 409         | `CONFLICT`          | The request is well-formed but not legal given current state (e.g. an illegal driver status transition). |
| 500         | `INTERNAL_ERROR`    | Unexpected server error. Message is generic; details are server-logged only. |

## Drivers

### `POST /drivers`

Create a driver. `location` is optional (a driver may not have a location yet); `status`
defaults to `offline`.

Request:

```json
{
  "name": "Ada Lovelace",
  "vehicleMake": "Toyota",
  "vehicleModel": "Prius",
  "vehicleColor": "blue",
  "vehiclePlate": "8ABC123",
  "location": { "lat": 37.7749, "lng": -122.4194 }
}
```

Response `201`:

```json
{
  "id": "6a1c9e0e-...",
  "name": "Ada Lovelace",
  "vehicleMake": "Toyota",
  "vehicleModel": "Prius",
  "vehicleColor": "blue",
  "vehiclePlate": "8ABC123",
  "status": "offline",
  "location": { "lat": 37.7749, "lng": -122.4194 },
  "lastUpdatedAt": "2026-01-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Failure — missing required field or `lat`/`lng` out of range (e.g. `lat: 200`) → `400
VALIDATION_ERROR`.

### `GET /drivers/:id`

Response `200`: same shape as above. `404 NOT_FOUND` if `:id` doesn't exist. `400
VALIDATION_ERROR` if `:id` isn't a valid UUID.

### `PATCH /drivers/:id/status`

Request:

```json
{ "status": "online" }
```

Response `200`: the updated driver (same shape as `POST /drivers`).

Legal status transitions:

| From      | To `online` | To `offline` | To `busy` |
| --------- | :---------: | :----------: | :-------: |
| `offline` |     ✅       |      —       |     ❌     |
| `online`  |     —       |      ✅       |     ✅     |
| `busy`    |     ✅       |      ❌       |     —     |

(`—` = already that status, a no-op `200`.) A driver must go `online` before being assigned a
trip (`busy`), and can't drop `offline` while `busy` — it must free up (`busy -> online`) first.

Failures:

- Unknown `status` value (not one of `online`/`offline`/`busy`) → `400 VALIDATION_ERROR`.
- Illegal transition per the table above (e.g. `offline -> busy`, `busy -> offline`) → `409
  CONFLICT`.
- Unknown `:id` → `404 NOT_FOUND`.

A status change is also mirrored into the live Redis view (see `docs/redis-geo.md`) — going
`offline` immediately removes the driver from nearby search, `busy`/`online` update the filter
Redis uses without touching their last known position.

### `PATCH /drivers/:id/location`

The "driver sent a location update" endpoint (Phase 4's WebSocket stream will call the
equivalent logic on every ping; this is the same operation over plain HTTP for now). Updates the
durable position in Postgres, then upserts the live position into Redis's `drivers:geo` index —
this is what makes a driver findable via `/drivers/nearby` and resets their staleness clock.

Request:

```json
{ "lat": 37.7749, "lng": -122.4194 }
```

Response `200`: the updated driver (same shape as `POST /drivers`).

Failures: out-of-range `lat`/`lng` → `400 VALIDATION_ERROR`. Unknown `:id` → `404 NOT_FOUND`.

### `GET /drivers/nearby`

Nearest online drivers to a point, sorted by distance ascending. Backed by Redis `GEOSEARCH`
(see `docs/redis-geo.md`) — this is the live/fast path, not a Postgres query, so it only returns
drivers who have sent at least one location update since coming online and haven't gone stale
(no update within `DRIVER_STALE_MS`, default 90s).

Query params:

| Param    | Required | Default | Bounds                                    |
| -------- | :------: | ------- | ------------------------------------------ |
| `lat`    |    ✅     | —       | -90 to 90                                   |
| `lng`    |    ✅     | —       | -180 to 180                                 |
| `radius` |          | 5000    | meters, 1 to 50,000 (50km)                  |
| `limit`  |          | 20      | 1 to 100                                    |

`radius`/`limit` outside their bounds are **rejected** with `400 VALIDATION_ERROR`, not silently
clamped.

Request: `GET /drivers/nearby?lat=37.7749&lng=-122.4194&radius=3000&limit=10`

Response `200`:

```json
{
  "drivers": [
    { "driverId": "6a1c9e0e-...", "distanceMeters": 812.4, "location": { "lat": 37.78, "lng": -122.415 } },
    { "driverId": "9d2f0a1b-...", "distanceMeters": 1950.1, "location": { "lat": 37.79, "lng": -122.41 } }
  ]
}
```

Always excludes `offline` and `busy` drivers, regardless of what radius/limit is requested.

## Riders

### `POST /riders`

Request:

```json
{ "name": "Grace Hopper" }
```

Response `201`:

```json
{ "id": "9f2b1a4e-...", "name": "Grace Hopper", "createdAt": "2026-01-01T00:00:00.000Z" }
```

Failure — missing `name` → `400 VALIDATION_ERROR`.

### `GET /riders/:id`

Response `200`: same shape as above. `404 NOT_FOUND` if `:id` doesn't exist.

## Trips

### `POST /trips`

A rider requests a trip with a pickup and dropoff point. The trip is created in `requested`
status with no driver assigned yet. The response returns immediately — it does **not** wait for
matching (see `docs/matching.md`), which runs asynchronously afterward and can take several
seconds (it may try more than one candidate driver, each with its own accept/decline timeout).
Poll `GET /trips/:id` or subscribe to the trip over WebSocket (`docs/websockets.md`) to learn the
outcome: `status: "matched"` with `driverId` set, or `status: "cancelled"` with
`cancellationReason` set to `"no_drivers_available"` or `"all_candidates_declined"`.

Request:

```json
{
  "riderId": "9f2b1a4e-...",
  "pickup": { "lat": 37.7749, "lng": -122.4194 },
  "dropoff": { "lat": 37.8044, "lng": -122.2712 }
}
```

Response `201`:

```json
{
  "id": "1cd60ab9-...",
  "riderId": "9f2b1a4e-...",
  "driverId": null,
  "status": "requested",
  "pickup": { "lat": 37.7749, "lng": -122.4194 },
  "dropoff": { "lat": 37.8044, "lng": -122.2712 },
  "requestedAt": "2026-01-01T00:00:00.000Z",
  "matchedAt": null,
  "startedAt": null,
  "completedAt": null,
  "distanceMeters": null,
  "durationSeconds": null,
  "cancellationReason": null,
  "fareEstimate": {
    "currency": "USD",
    "baseCents": 250,
    "distanceCents": 2014,
    "timeCents": 699,
    "subtotalCents": 2964,
    "surgeMultiplier": 1.4,
    "totalCents": 4150
  }
}
```

`fareEstimate` (Phase 13, `docs/surge-pricing.md`) is a fresh quote computed at request time — base
+ distance + time, multiplied by the pickup zone's current surge multiplier — not persisted; a
later `GET /trips/:id` won't show it.

Failures:

- `pickup`/`dropoff` with an out-of-range `lat`/`lng` (e.g. `lat: 200`) → `400 VALIDATION_ERROR`.
- `riderId` doesn't reference an existing rider → `404 NOT_FOUND`.

### `GET /trips/:id`

Response `200`: same shape as above. `404 NOT_FOUND` if `:id` doesn't exist.

### `GET /trips/:id/eta`

Heuristic ETA (haversine distance / configurable average speed, adjusted for rush hour), the
trained ML model (Phase 9), or ML-with-heuristic-fallback — selectable via `ETA_MODE`, no
redeploy needed. See `docs/eta.md` for the heuristic's design and `docs/eta-integration.md` for
the mode toggle, the ML timeout/fallback/caching behavior, and observability. Always `200` with a
`status` field describing which case applies — `404` is reserved for a genuinely unknown `:id`.

Response `200` (driver assigned, fresh location):

```json
{
  "tripId": "1cd60ab9-...",
  "status": "ok",
  "etaSeconds": 342.7,
  "distanceMeters": 2740.1,
  "computedAt": "2026-01-01T00:00:05.000Z",
  "driverLocationAgeMs": 1240,
  "etaSource": "ml",
  "servedFromCache": false
}
```

Response headers (Phase 10, mirroring `etaSource`/`servedFromCache` for observability without
parsing the body): `X-ETA-Source: heuristic|ml|ml_fallback|none`, `X-ETA-Cache: hit|miss|n/a`.

`status` is one of:

| `status` | Meaning | `etaSeconds` |
| --- | --- | --- |
| `ok` | Driver assigned, location fresh. | Current estimate. |
| `no_driver_assigned` | Trip has no driver yet (still `requested`). | `null` |
| `trip_completed` | Trip is `completed`. | `0` |
| `trip_cancelled` | Trip is `cancelled`. | `null` |
| `stale_location` | Driver has no location yet, or it's older than `ETA_STALE_LOCATION_MS`. | Last cached value if one exists, else `null`. |
| `ml_unavailable` | `ETA_MODE=ml` only — an ML attempt just failed and there's no fallback. | Last cached value if one exists, else `null`. |

## Surge

### `GET /surge`

Every currently-tracked zone's surge multiplier (Phase 13, `docs/surge-pricing.md`) — updated on a
fixed background interval, never computed per-request.

Response `200`:

```json
{
  "zones": [
    {
      "zoneId": "20334525",
      "center": { "lat": 37.781982421875, "lng": -122.40966796875 },
      "multiplier": 2.8,
      "requestCount": 6,
      "driverCount": 1,
      "updatedAt": "2026-08-04T12:10:26.106Z"
    }
  ]
}
```

### `GET /surge?lat=&lng=`

Just the multiplier for the zone covering one point (both params required together):

```json
{ "lat": 37.7749, "lng": -122.4194, "multiplier": 3 }
```

Failure: `lat`/`lng` out of range, or only one of the two provided → `400 VALIDATION_ERROR`.

### `ml-service`'s `POST /predict-eta`

The trained ML ETA model (Phase 9) is a separate service with its own API — not documented here
since this file covers `core`'s REST API specifically. See `docs/eta-model.md` for the full
request/response shape, validation behavior, and how it compares against this endpoint's
heuristic.

### `GET /internal/metrics`

Diagnostics added for load testing (Phase 11) — event loop lag, the Postgres pool's live
`totalCount`/`idleCount`/`waitingCount`, process memory, and WS/batch fleet sizes. See
`docs/load-testing.md` for how this was used to find and confirm a real bottleneck.
Unauthenticated and unversioned by design (a dev/ops diagnostic for a single-tenant project at
this stage) — would need auth before ever being exposed outside a trusted network.

## Request logging

Every request logs `method`, `path`, `statusCode`, and `latencyMs` on response (see
`src/plugins/request-logging.ts`), regardless of route or outcome.

## Running the tests

```
cd core
npm test
```

This brings up a disposable, tmpfs-backed Postgres container plus a disposable Redis container
(`infra/docker-compose.test.yml`, ports 5433/6380 — separate from the dev database/cache on
5432/6379), runs migrations against Postgres, runs the integration test suite (Fastify's
`app.inject()` against the real service + real Postgres + real Redis, no mocked DB/cache layer),
and tears both containers down afterwards regardless of pass/fail. It never touches dev data.

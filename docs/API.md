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
status with no driver assigned yet (matching is Phase 6).

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
  "cancellationReason": null
}
```

Failures:

- `pickup`/`dropoff` with an out-of-range `lat`/`lng` (e.g. `lat: 200`) → `400 VALIDATION_ERROR`.
- `riderId` doesn't reference an existing rider → `404 NOT_FOUND`.

### `GET /trips/:id`

Response `200`: same shape as above. `404 NOT_FOUND` if `:id` doesn't exist.

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

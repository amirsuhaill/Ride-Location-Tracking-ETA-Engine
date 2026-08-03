# ride-tracking

Monorepo for the ride-tracking & ETA engine project.

- `/core` — Node.js + TypeScript (Fastify) service: API, WebSocket server, and matching logic.
- `/ml-service` — Python + FastAPI service for the ETA model.
- `/infra` — docker-compose stack: PostgreSQL (with PostGIS), Redis, and both services.

## Prerequisites

- Docker Engine 24+ with Compose v2 (`docker compose version`)
- Node.js 20+ (for local, non-Docker development of `/core`)
- Python 3.12+ (for local, non-Docker development of `/ml-service`)

## Quickstart

```
make up
```

(equivalently: `npm run up`)

This builds and starts Postgres, Redis, `core`, and `ml-service` on a shared Docker
network, with no manual setup steps. Working `.env` files with local dev, non-secret
defaults are already present next to each service's `.env.example` (gitignored — regenerate
them from the `.env.example` files if missing).

Other commands:

```
make down   # stop and remove containers
make logs   # follow logs from all services
make ps     # list running services
```

## Verify it's working

```
curl http://localhost:3000/health   # core
curl http://localhost:8000/health   # ml-service

# cross-service reachability by Docker service name (not localhost)
docker compose -f infra/docker-compose.yml exec core curl -sS http://ml-service:8000/health
docker compose -f infra/docker-compose.yml exec ml-service curl -sS http://core:3000/health

# PostGIS is actually enabled, not just installed
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U ridetracking -d ridetracking -c "SELECT PostGIS_version();"
```

## Configuration

Each service reads its config from environment variables — see `core/.env.example` and
`ml-service/.env.example` for the full list. `infra/.env.example` documents the
Postgres/Redis/port settings used by docker-compose. Copy any `.env.example` to `.env` to
customize; the `.env` files already on disk hold local-dev-only, non-secret defaults.

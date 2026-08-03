#!/usr/bin/env bash
# Runs the integration test suite against a disposable Postgres + Redis pair — never the dev
# database/cache. Both containers always get torn down (trap on EXIT), whether the tests pass,
# fail, or the script itself errors out.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$SCRIPT_DIR/.."
INFRA_DIR="$CORE_DIR/../infra"

COMPOSE=(docker compose --env-file "$INFRA_DIR/.env.test" -f "$INFRA_DIR/docker-compose.test.yml")

cleanup() {
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${COMPOSE[@]}" up -d --wait

set -a
# shellcheck disable=SC1091
source "$INFRA_DIR/.env.test"
set +a

export DATABASE_URL="postgres://${TEST_POSTGRES_USER}:${TEST_POSTGRES_PASSWORD}@localhost:${TEST_POSTGRES_PORT}/${TEST_POSTGRES_DB}"
export REDIS_URL="redis://localhost:${TEST_REDIS_PORT}"

cd "$CORE_DIR"

# The postgres image restarts its process internally after running docker-entrypoint-initdb.d
# scripts (ours enables PostGIS) — pg_isready can report healthy against that transient instance
# a moment before the real one comes up, so the first migration attempt can hit a connection
# reset. Retry rather than race it.
for attempt in $(seq 1 10); do
  if npm run migrate:up; then
    break
  fi
  if [ "$attempt" -eq 10 ]; then
    echo "migrate:up did not succeed after $attempt attempts" >&2
    exit 1
  fi
  sleep 1
done

npx vitest run

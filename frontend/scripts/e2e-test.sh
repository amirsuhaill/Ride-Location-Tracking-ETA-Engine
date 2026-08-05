#!/usr/bin/env bash
# Runs the real end-to-end Playwright suite against a fully disposable stack: the same
# postgres-test/redis-test containers core/scripts/test.sh already uses (never the dev
# database/cache), plus a real `core` server process and a real frontend dev server, both on
# distinct ports so this never collides with anything already running for local dev/manual
# verification. Everything gets torn down (trap on EXIT) whether the tests pass, fail, or this
# script itself errors out — mirrors core/scripts/test.sh's own structure deliberately, not a
# reinvention of it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/.."
CORE_DIR="$FRONTEND_DIR/../core"
INFRA_DIR="$FRONTEND_DIR/../infra"

CORE_TEST_PORT="${CORE_TEST_PORT:-3011}"
FRONTEND_TEST_PORT="${FRONTEND_TEST_PORT:-5181}"
CORE_LOG="/tmp/ride-tracking-e2e-core.log"
FRONTEND_LOG="/tmp/ride-tracking-e2e-frontend.log"

COMPOSE=(docker compose --env-file "$INFRA_DIR/.env.test" -f "$INFRA_DIR/docker-compose.test.yml")

CORE_PID=""
FRONTEND_PID=""

cleanup() {
  echo "--- tearing down: core process, frontend process, disposable postgres/redis ---"
  if [ -n "$FRONTEND_PID" ]; then kill "$FRONTEND_PID" >/dev/null 2>&1 || true; fi
  if [ -n "$CORE_PID" ]; then kill "$CORE_PID" >/dev/null 2>&1 || true; fi
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- starting disposable postgres-test/redis-test (infra/docker-compose.test.yml) ---"
"${COMPOSE[@]}" up -d --wait

set -a
# shellcheck disable=SC1091
source "$INFRA_DIR/.env.test"
set +a

export DATABASE_URL="postgres://${TEST_POSTGRES_USER}:${TEST_POSTGRES_PASSWORD}@localhost:${TEST_POSTGRES_PORT}/${TEST_POSTGRES_DB}"
export REDIS_URL="redis://localhost:${TEST_REDIS_PORT}"

echo "--- running core's migrations against the disposable test database ---"
cd "$CORE_DIR"
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

echo "--- starting a real core server on port $CORE_TEST_PORT (log: $CORE_LOG) ---"
PORT="$CORE_TEST_PORT" \
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  CORS_ORIGINS="http://localhost:$FRONTEND_TEST_PORT" \
  NODE_ENV=test \
  npx tsx src/index.ts >"$CORE_LOG" 2>&1 &
CORE_PID=$!

echo "--- waiting for core's real /health ---"
for attempt in $(seq 1 30); do
  if curl -sf "http://localhost:$CORE_TEST_PORT/health" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "core never became healthy — see $CORE_LOG" >&2
    cat "$CORE_LOG" >&2
    exit 1
  fi
  sleep 1
done
echo "core is up."

echo "--- starting a real frontend dev server on port $FRONTEND_TEST_PORT (log: $FRONTEND_LOG) ---"
cd "$FRONTEND_DIR"
VITE_CORE_API_URL="http://localhost:$CORE_TEST_PORT" \
  VITE_CORE_WS_URL="ws://localhost:$CORE_TEST_PORT" \
  npx vite --port "$FRONTEND_TEST_PORT" --strictPort >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

echo "--- waiting for the frontend dev server ---"
for attempt in $(seq 1 30); do
  if curl -sf "http://localhost:$FRONTEND_TEST_PORT/" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "frontend dev server never came up — see $FRONTEND_LOG" >&2
    cat "$FRONTEND_LOG" >&2
    exit 1
  fi
  sleep 1
done
echo "frontend is up."

echo "--- running the real Playwright end-to-end suite ---"
E2E_APP_URL="http://localhost:$FRONTEND_TEST_PORT" \
  E2E_CORE_URL="http://localhost:$CORE_TEST_PORT" \
  E2E_CORE_WS_URL="ws://localhost:$CORE_TEST_PORT" \
  npx playwright test

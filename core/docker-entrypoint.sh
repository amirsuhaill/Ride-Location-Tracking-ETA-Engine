#!/bin/sh
# Migrations run every real container start, not just once manually — node-pg-migrate tracks
# already-applied migrations in its own table, so re-running this against an already-migrated
# database is a safe no-op. Without this, a genuinely fresh `docker compose down -v && make up`
# leaves the API returning 500s the moment any route touches a real table (confirmed live: a
# fresh volume + this image's previous CMD produced `relation "trips" does not exist`) — this was
# a real, previously-undocumented manual step (Frontend Phase 10 surfaced it while verifying a
# genuinely fresh volume end to end, docs/frontend-deploy.md).
#
# The retry loop mirrors core/scripts/test.sh's own — the postgres/PostGIS image restarts its
# process internally after running docker-entrypoint-initdb.d scripts, and pg_isready (this
# image's own healthcheck) can report healthy a moment before the real instance is back, so the
# very first migration attempt on a truly fresh volume can hit a connection reset.
set -e

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

#!/usr/bin/env bash
# Phase 15 — prepares real OSM road-network data for OSRM, scoped to this project's simulated
# city (the SF bounding box used throughout core/scripts/seed.ts, core/scripts/lib/trip-simulator.ts,
# etc.). See docs/osrm-routing.md.
#
# Fetches only the road network (Overpass QL: `way[highway]` + referenced nodes) for the exact
# bbox this project already uses, rather than a full regional .osm.pbf extract (hundreds of MB) —
# a targeted fetch is enough for OSRM's car profile and finishes in well under a minute on a
# laptop. Then runs OSRM's standard extract -> contract (Contraction Hierarchies) pipeline.
#
# Usage: bash infra/scripts/prepare-osrm-data.sh
# Output: infra/osrm-data/sf.osrm (+ its many .osrm.* companion files) — gitignored build
# artifacts, regenerable by re-running this script; nothing here is committed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../osrm-data"
mkdir -p "$DATA_DIR"

# Matches SF_BBOX in core/scripts/seed.ts / core/scripts/lib/trip-simulator.ts exactly.
MIN_LAT=37.708
MAX_LAT=37.812
MIN_LNG=-122.514
MAX_LNG=-122.386

OSM_FILE="$DATA_DIR/sf.osm"
OSRM_FILE="$DATA_DIR/sf.osrm"

if [ -f "$OSM_FILE" ]; then
  echo "Found existing $OSM_FILE — skipping download. Delete it to re-fetch."
else
  echo "Fetching SF road network from Overpass API (bbox: $MIN_LAT,$MIN_LNG,$MAX_LAT,$MAX_LNG) ..."
  cat > "$DATA_DIR/query.overpassql" << EOF
[bbox:${MIN_LAT},${MIN_LNG},${MAX_LAT},${MAX_LNG}][timeout:180][out:xml];
(
  way[highway];
);
(._;>;);
out body;
EOF
  curl -sS -m 150 --data-urlencode "data@$DATA_DIR/query.overpassql" \
    https://overpass-api.de/api/interpreter -o "$OSM_FILE"
  echo "Fetched $(du -h "$OSM_FILE" | cut -f1) of OSM data."
fi

echo "Running osrm-extract (car profile) ..."
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend osrm-extract -p /opt/car.lua /data/sf.osm

echo "Running osrm-contract (Contraction Hierarchies preprocessing) ..."
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend osrm-contract /data/sf.osrm

echo ""
echo "Done. $OSRM_FILE and its companion files are ready."
echo "Start the OSRM service with: docker compose up -d osrm (see infra/docker-compose.yml)"

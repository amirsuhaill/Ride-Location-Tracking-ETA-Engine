import { pool } from "../src/db";

// The seed script only creates 20 drivers, which is too few for the planner to ever prefer an
// index scan over a sequential scan (the whole table fits in one page). To honestly demonstrate
// the GIST index is used, bulk-insert a much larger synthetic set inside a transaction, run
// EXPLAIN ANALYZE, then roll back so this script never leaves extra rows behind.
const BULK_ROW_COUNT = 20_000;

const SF_BBOX = {
  minLat: 37.708,
  maxLat: 37.812,
  minLng: -122.514,
  maxLng: -122.386,
};

// A real point inside the seeded SF bbox to search near (Union Square-ish).
const QUERY_LNG = -122.4075;
const QUERY_LAT = 37.7875;
const RADIUS_METERS = 3000;

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO drivers (name, vehicle_make, vehicle_model, vehicle_color, vehicle_plate, status, current_location)
       SELECT
         'bench-driver-' || g,
         'BenchMake',
         'BenchModel',
         'black',
         'BENCH' || g,
         (ARRAY['online','online','online','busy','offline'])[1 + floor(random() * 5)::int]::driver_status,
         ST_SetSRID(
           ST_MakePoint(
             $1::double precision + random() * ($2::double precision - $1::double precision),
             $3::double precision + random() * ($4::double precision - $3::double precision)
           ),
           4326
         )::geography
       FROM generate_series(1, $5::int) AS g`,
      [SF_BBOX.minLng, SF_BBOX.maxLng, SF_BBOX.minLat, SF_BBOX.maxLat, BULK_ROW_COUNT],
    );

    // Planner needs fresh stats to know the table just grew from ~20 to ~20,000 rows.
    await client.query("ANALYZE drivers");

    const { rows: countRows } = await client.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM drivers",
    );
    console.log(`drivers table at benchmark time: ${countRows[0]?.count} rows`);

    const { rows: planRows } = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT id, name,
              current_location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS distance_m
       FROM drivers
       WHERE status = 'online'
         AND ST_DWithin(current_location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
       ORDER BY current_location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
       LIMIT 10`,
      [QUERY_LNG, QUERY_LAT, RADIUS_METERS],
    );

    const plan = planRows.map((r) => r["QUERY PLAN"]).join("\n");
    console.log("\n--- EXPLAIN ANALYZE ---\n");
    console.log(plan);

    await client.query("ROLLBACK");
    console.log(`\n(rolled back — the ${BULK_ROW_COUNT} benchmark rows above were not persisted)`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("Explain benchmark failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

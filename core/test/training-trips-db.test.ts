import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { resetDb } from "./helpers/db";
import { generateTrips, DEFAULT_SIMULATOR_CONFIG } from "../scripts/lib/trip-simulator";
import { deletePriorRun, insertTrips } from "../scripts/simulate-historical-trips";

describe("training_trips: bulk insert + reseed idempotency (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("persists every generated field correctly, round-tripped through Postgres", async () => {
    const [trip] = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 1, seed: 5 });
    await insertTrips([trip!], 5);

    const { rows } = await pool.query(
      `SELECT
         ST_Y(pickup_location::geometry) AS pickup_lat, ST_X(pickup_location::geometry) AS pickup_lng,
         ST_Y(dropoff_location::geometry) AS dropoff_lat, ST_X(dropoff_location::geometry) AS dropoff_lng,
         requested_at, naive_distance_meters, naive_duration_seconds,
         actual_distance_meters, actual_duration_seconds,
         time_of_day_multiplier, zone_density_factor, noise_factor, simulation_seed
       FROM training_trips`,
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.pickup_lat).toBeCloseTo(trip!.pickup.lat, 5);
    expect(row.pickup_lng).toBeCloseTo(trip!.pickup.lng, 5);
    expect(row.dropoff_lat).toBeCloseTo(trip!.dropoff.lat, 5);
    expect(row.dropoff_lng).toBeCloseTo(trip!.dropoff.lng, 5);
    expect(new Date(row.requested_at).getTime()).toBe(trip!.requestedAt.getTime());
    expect(row.naive_distance_meters).toBeCloseTo(trip!.naiveDistanceMeters, 3);
    expect(row.actual_duration_seconds).toBeCloseTo(trip!.actualDurationSeconds, 3);
    expect(row.simulation_seed).toBe(5);
  });

  it("re-running with the same seed replaces prior rows instead of accumulating duplicates", async () => {
    const firstRun = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 50, seed: 99 });
    await insertTrips(firstRun, 99);

    const { rows: afterFirst } = await pool.query(
      "SELECT count(*)::int AS count FROM training_trips WHERE simulation_seed = $1",
      [99],
    );
    expect(afterFirst[0].count).toBe(50);

    // Re-run with the same config/seed: delete-then-insert (the real script's own sequence).
    const secondRun = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 50, seed: 99 });
    await deletePriorRun(99);
    await insertTrips(secondRun, 99);

    const { rows: afterSecond } = await pool.query(
      "SELECT count(*)::int AS count FROM training_trips WHERE simulation_seed = $1",
      [99],
    );
    expect(afterSecond[0].count).toBe(50); // not 100 — the prior run's rows were replaced
  });

  it("rows from different seeds coexist independently", async () => {
    await insertTrips(
      generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 10, seed: 1 }),
      1,
    );
    await insertTrips(
      generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 20, seed: 2 }),
      2,
    );

    const { rows } = await pool.query(
      "SELECT simulation_seed, count(*)::int AS count FROM training_trips GROUP BY simulation_seed ORDER BY simulation_seed",
    );
    expect(rows).toEqual([
      { simulation_seed: 1, count: 10 },
      { simulation_seed: 2, count: 20 },
    ]);

    await deletePriorRun(1);
    const { rows: afterDelete } = await pool.query(
      "SELECT count(*)::int AS count FROM training_trips",
    );
    expect(afterDelete[0].count).toBe(20); // only seed 1's rows were removed
  });
});

import { pool } from "../../src/db";

export async function resetDb(): Promise<void> {
  await pool.query(
    "TRUNCATE TABLE location_history, trips, drivers, riders, training_trips RESTART IDENTITY CASCADE",
  );
}

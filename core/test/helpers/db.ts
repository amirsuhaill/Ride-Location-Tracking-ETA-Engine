import { pool } from "../../src/db";

export async function resetDb(): Promise<void> {
  await pool.query(
    "TRUNCATE TABLE location_history, trips, drivers, riders RESTART IDENTITY CASCADE",
  );
}

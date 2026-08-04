import { pool } from "../db";
import { findStaleDrivers, evictStaleDriver } from "../repositories/drivers.geo.repository";
import { logger } from "../logger";

// Answers "what happens if Redis and Postgres disagree about a driver's status": Redis is the
// fast, ephemeral "live" view used for nearby search; Postgres is the durable source of truth.
// The most common way they disagree is a driver's app/connection dying without ever sending an
// explicit "offline" update — Redis would otherwise say "online" forever. This job is the
// convergence mechanism: it treats "no update in driverStaleMs" as proof the driver is actually
// offline, evicts them from the live Redis geo index immediately, and corrects Postgres to
// match. Nearby search itself never has to wait for this job to run — searchNearby() already
// re-checks freshness on every query — so this is strictly cleanup/convergence, not a
// correctness dependency.
export async function reconcileStaleDrivers(nowMs: number = Date.now()): Promise<number> {
  const stale = await findStaleDrivers(nowMs);

  for (const { driverId } of stale) {
    await evictStaleDriver(driverId);
    await pool.query(
      `UPDATE drivers SET status = 'offline', last_updated_at = now()
       WHERE id = $1 AND status <> 'offline'`,
      [driverId],
    );
  }

  return stale.length;
}

let reconcileTimer: NodeJS.Timeout | undefined;

export function startReconciliationJob(intervalMs: number): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    reconcileStaleDrivers().catch((err: unknown) => {
      logger.error({ err }, "reconcileStaleDrivers failed");
    });
  }, intervalMs);
  reconcileTimer.unref();
}

export function stopReconciliationJob(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  }
}

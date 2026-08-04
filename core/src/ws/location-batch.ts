import * as driversRepo from "../repositories/drivers.repository";
import * as driversGeoRepo from "../repositories/drivers.geo.repository";
import { broadcastDriverLocation } from "./subscriptions";
import { handleDriverLocationUpdatesBatch } from "../services/eta.service";
import { logger } from "../logger";
import { locationUpdatesTotal, broadcastLatencySeconds } from "../metrics/registry";

// Fleet-wide batching, separate from (and layered on top of) Phase 4's per-driver throttle:
// the throttle decides WHEN a given driver's update becomes eligible to process (protects
// against one chatty/malicious driver); this module decides HOW eligible updates get flushed to
// Redis/Postgres/subscribers — accumulated into a shared window and flushed together, rather
// than one Redis pipeline + one Postgres UPDATE + one broadcast pass per individual update. See
// docs/ws-batching-and-compression.md.
interface PendingUpdate {
  lat: number;
  lng: number;
  timestamp: number;
}

const pendingBatch = new Map<string, PendingUpdate>();

/** Last-value-wins if a driver lands in the same window twice (e.g. its throttle window is
 * shorter than the batch window) — same coalescing philosophy as Phase 4's per-driver throttle. */
export function enqueueLocationUpdate(driverId: string, update: PendingUpdate): void {
  pendingBatch.set(driverId, update);
  locationUpdatesTotal.inc();
}

/** Also used by GET /internal/metrics (Phase 11, docs/load-testing.md) — a growing pending
 * batch size under sustained load is a direct symptom of flushBatch() taking longer than the
 * batch window to complete (see that doc's bottleneck write-up). */
export function getPendingBatchSize(): number {
  return pendingBatch.size;
}

let flushing = false;

/** Exported directly so tests (and the load-test script) can flush deterministically instead of
 * waiting on the real interval. Guards against overlapping runs if a previous flush is still
 * in flight (a slow Postgres/Redis round trip under real load shouldn't stack flushes). */
export async function flushBatch(): Promise<void> {
  if (flushing) return;
  if (pendingBatch.size === 0) return;
  flushing = true;
  try {
    const snapshot = Array.from(pendingBatch.entries());
    pendingBatch.clear();

    const updatedDrivers = await driversRepo.batchUpdateLocations(
      snapshot.map(([driverId, u]) => ({ id: driverId, lat: u.lat, lng: u.lng })),
    );
    const driverById = new Map(updatedDrivers.map((d) => [d.id, d]));

    const geoEntries = snapshot
      .map(([driverId, u]) => {
        const driver = driverById.get(driverId);
        // Driver vanished between enqueue and flush (deleted) — nothing left to update/broadcast.
        if (!driver) return null;
        return { driverId, lat: u.lat, lng: u.lng, status: driver.status };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    await driversGeoRepo.upsertDriverLocationsBatch(geoEntries);

    const driversWithBroadcast: Array<{ driverId: string; update: PendingUpdate }> = [];
    for (const [driverId, update] of snapshot) {
      const driver = driverById.get(driverId);
      if (!driver) continue; // driver vanished between enqueue and flush (deleted)
      broadcastDriverLocation(driverId, {
        driverId,
        lat: update.lat,
        lng: update.lng,
        timestamp: update.timestamp,
        status: driver.status,
      });
      // "Added latency" in docs/ws-batching-and-compression.md's batch-window tradeoff table —
      // send timestamp to broadcast, dominated by the batch window on localhost.
      broadcastLatencySeconds.observe(Math.max(0, Date.now() - update.timestamp) / 1000);
      driversWithBroadcast.push({ driverId, update });
    }

    // One query for the whole batch's active-trip lookups (Phase 11, docs/load-testing.md) —
    // isolated so a failure here never blocks the broadcasts above, which have already gone out.
    try {
      await handleDriverLocationUpdatesBatch(
        driversWithBroadcast.map(({ driverId, update }) => ({
          driverId,
          lat: update.lat,
          lng: update.lng,
          timestampMs: update.timestamp,
        })),
      );
    } catch (err: unknown) {
      logger.error({ err }, "handleDriverLocationUpdatesBatch failed");
    }
  } finally {
    flushing = false;
  }
}

let batchTimer: NodeJS.Timeout | undefined;

export function startBatchLoop(intervalMs: number): void {
  if (batchTimer) return;
  batchTimer = setInterval(() => {
    flushBatch().catch((err: unknown) => logger.error({ err }, "flushBatch failed"));
  }, intervalMs);
  batchTimer.unref();
}

export function stopBatchLoop(): void {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = undefined;
  }
}

export function resetLocationBatchForTests(): void {
  pendingBatch.clear();
  flushing = false;
}

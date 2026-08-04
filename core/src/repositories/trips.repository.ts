import { pool } from "../db";
import type { CreateTripInput, TripStatus } from "../schemas/trips";

export interface Trip {
  id: string;
  riderId: string;
  driverId: string | null;
  status: TripStatus;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  requestedAt: Date;
  matchedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  cancellationReason: string | null;
}

interface TripRow {
  id: string;
  riderId: string;
  driverId: string | null;
  status: TripStatus;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  requestedAt: Date;
  matchedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  cancellationReason: string | null;
}

function mapRow(row: TripRow): Trip {
  return {
    id: row.id,
    riderId: row.riderId,
    driverId: row.driverId,
    status: row.status,
    pickup: { lat: row.pickupLat, lng: row.pickupLng },
    dropoff: { lat: row.dropoffLat, lng: row.dropoffLng },
    requestedAt: row.requestedAt,
    matchedAt: row.matchedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    distanceMeters: row.distanceMeters,
    durationSeconds: row.durationSeconds,
    cancellationReason: row.cancellationReason,
  };
}

const SELECT_COLUMNS = `
  id, rider_id AS "riderId", driver_id AS "driverId", status,
  ST_Y(pickup_location::geometry) AS "pickupLat", ST_X(pickup_location::geometry) AS "pickupLng",
  ST_Y(dropoff_location::geometry) AS "dropoffLat", ST_X(dropoff_location::geometry) AS "dropoffLng",
  requested_at AS "requestedAt", matched_at AS "matchedAt", started_at AS "startedAt",
  completed_at AS "completedAt", distance_meters AS "distanceMeters",
  duration_seconds AS "durationSeconds", cancellation_reason AS "cancellationReason"
`;

export async function insertTrip(input: CreateTripInput): Promise<Trip> {
  const { rows } = await pool.query<TripRow>(
    `INSERT INTO trips (rider_id, pickup_location, dropoff_location)
     VALUES (
       $1,
       ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
       ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography
     )
     RETURNING ${SELECT_COLUMNS}`,
    [input.riderId, input.pickup.lng, input.pickup.lat, input.dropoff.lng, input.dropoff.lat],
  );
  const row = rows[0];
  if (!row) throw new Error("insertTrip: INSERT ... RETURNING produced no row");
  return mapRow(row);
}

export async function findTripById(id: string): Promise<Trip | null> {
  const { rows } = await pool.query<TripRow>(`SELECT ${SELECT_COLUMNS} FROM trips WHERE id = $1`, [
    id,
  ]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface TripPickup {
  id: string;
  lat: number;
  lng: number;
}

/** Pickup points of every currently-open (unmatched) trip request — "open demand" for
 * surge.service.ts (Phase 13) to tally per zone. Once a trip is matched it's no longer waiting
 * on supply, so it stops counting as demand pressure in this sense — the surge signal is about
 * riders currently waiting for a driver, not total ride volume. */
export async function findOpenTripPickups(): Promise<TripPickup[]> {
  const { rows } = await pool.query<{ id: string; lat: number; lng: number }>(
    `SELECT id, ST_Y(pickup_location::geometry) AS lat, ST_X(pickup_location::geometry) AS lng
     FROM trips
     WHERE status = 'requested'`,
  );
  return rows;
}

/** The one trip a driver is currently en route on, if any — a driver is "busy" for exactly one
 * trip at a time, so this is at most one row in practice (see docs/matching.md). Used by
 * eta.service.ts to find which trip's ETA to recompute when a driver's location updates. */
export async function findActiveTripForDriver(driverId: string): Promise<Trip | null> {
  const { rows } = await pool.query<TripRow>(
    `SELECT ${SELECT_COLUMNS} FROM trips
     WHERE driver_id = $1 AND status IN ('matched', 'in_progress')
     LIMIT 1`,
    [driverId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Batched form of findActiveTripForDriver — one query for a whole set of drivers instead of one
 * query per driver (Phase 11, docs/load-testing.md). ws/location-batch.ts's flushBatch() already
 * batches every OTHER per-flush write (Postgres position UPDATE, Redis geo upsert — Phase 5); this
 * was the one remaining per-driver round trip in that same hot path, and at fleet scale it
 * saturated the Postgres pool (default max 10) badly enough to back up an entire batch window —
 * measured via GET /internal/metrics' pgPool.waitingCount, not a guess.
 */
export async function findActiveTripsForDrivers(driverIds: string[]): Promise<Map<string, Trip>> {
  if (driverIds.length === 0) return new Map();
  const { rows } = await pool.query<TripRow>(
    `SELECT ${SELECT_COLUMNS} FROM trips
     WHERE driver_id = ANY($1) AND status IN ('matched', 'in_progress')`,
    [driverIds],
  );
  const trips = rows.map(mapRow);
  return new Map(trips.map((trip) => [trip.driverId as string, trip]));
}

// The atomic "point of no return" for a match: both guarded UPDATEs run in one transaction, so
// either both take effect or neither does. The WHERE guards (trip still "requested" and
// unassigned; driver still "online") are what make this safe even if it were ever reached
// concurrently for the same driver — see docs/matching.md. In normal operation the Redis lock
// in driver-lock.repository.ts already prevents that concurrency from happening at all; this is
// the second, independent layer.
export async function tryFinalizeMatch(tripId: string, driverId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tripUpdate = await client.query(
      `UPDATE trips SET status = 'matched', driver_id = $2, matched_at = now()
       WHERE id = $1 AND status = 'requested' AND driver_id IS NULL`,
      [tripId, driverId],
    );
    const driverUpdate = await client.query(
      `UPDATE drivers SET status = 'busy', last_updated_at = now()
       WHERE id = $1 AND status = 'online'`,
      [driverId],
    );

    if (tripUpdate.rowCount === 0 || driverUpdate.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Terminates a trip that couldn't be matched, with a specific machine-readable reason
 * ("no_drivers_available" / "all_candidates_declined") — reuses the existing `cancelled` +
 * `cancellation_reason` terminal state rather than adding new trip_status enum values (Postgres
 * enums can't have a value removed, which would make an added value's migration effectively
 * irreversible — see docs/matching.md). Guarded on status='requested' so this can't clobber a
 * trip that was somehow matched in the meantime. */
export async function markTripUnmatched(tripId: string, reason: string): Promise<Trip | null> {
  const { rows } = await pool.query<TripRow>(
    `UPDATE trips SET status = 'cancelled', cancellation_reason = $2
     WHERE id = $1 AND status = 'requested'
     RETURNING ${SELECT_COLUMNS}`,
    [tripId, reason],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

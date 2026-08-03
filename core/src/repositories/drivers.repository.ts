import { pool } from "../db";
import type { CreateDriverInput, DriverStatus } from "../schemas/drivers";

export interface Driver {
  id: string;
  name: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  vehiclePlate: string;
  status: DriverStatus;
  location: { lat: number; lng: number } | null;
  lastUpdatedAt: Date;
  createdAt: Date;
}

interface DriverRow {
  id: string;
  name: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  vehiclePlate: string;
  status: DriverStatus;
  lat: number | null;
  lng: number | null;
  lastUpdatedAt: Date;
  createdAt: Date;
}

function mapRow(row: DriverRow): Driver {
  return {
    id: row.id,
    name: row.name,
    vehicleMake: row.vehicleMake,
    vehicleModel: row.vehicleModel,
    vehicleColor: row.vehicleColor,
    vehiclePlate: row.vehiclePlate,
    status: row.status,
    location: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    lastUpdatedAt: row.lastUpdatedAt,
    createdAt: row.createdAt,
  };
}

const SELECT_COLUMNS = `
  id, name,
  vehicle_make AS "vehicleMake", vehicle_model AS "vehicleModel",
  vehicle_color AS "vehicleColor", vehicle_plate AS "vehiclePlate",
  status,
  CASE WHEN current_location IS NULL THEN NULL ELSE ST_X(current_location::geometry) END AS lng,
  CASE WHEN current_location IS NULL THEN NULL ELSE ST_Y(current_location::geometry) END AS lat,
  last_updated_at AS "lastUpdatedAt", created_at AS "createdAt"
`;

export async function insertDriver(input: CreateDriverInput): Promise<Driver> {
  const status = input.status ?? "offline";
  const { rows } = await pool.query<DriverRow>(
    `INSERT INTO drivers (name, vehicle_make, vehicle_model, vehicle_color, vehicle_plate, status, current_location)
     VALUES ($1, $2, $3, $4, $5, $6,
       CASE WHEN $7::double precision IS NULL OR $8::double precision IS NULL
         THEN NULL
         ELSE ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography
       END)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.name,
      input.vehicleMake,
      input.vehicleModel,
      input.vehicleColor,
      input.vehiclePlate,
      status,
      input.location?.lng ?? null,
      input.location?.lat ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("insertDriver: INSERT ... RETURNING produced no row");
  return mapRow(row);
}

export async function findDriverById(id: string): Promise<Driver | null> {
  const { rows } = await pool.query<DriverRow>(
    `SELECT ${SELECT_COLUMNS} FROM drivers WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateDriverStatus(id: string, status: DriverStatus): Promise<Driver | null> {
  const { rows } = await pool.query<DriverRow>(
    `UPDATE drivers SET status = $2, last_updated_at = now()
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, status],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateDriverLocation(
  id: string,
  lat: number,
  lng: number,
): Promise<Driver | null> {
  const { rows } = await pool.query<DriverRow>(
    `UPDATE drivers
     SET current_location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
         last_updated_at = now()
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, lng, lat],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface BatchLocationEntry {
  id: string;
  lat: number;
  lng: number;
}

// Same column list as SELECT_COLUMNS, but qualified with the "d" alias — this query joins
// against an UNNEST(...) row source that also has an "id" column, so unqualified names would be
// ambiguous.
const BATCH_SELECT_COLUMNS = `
  d.id, d.name,
  d.vehicle_make AS "vehicleMake", d.vehicle_model AS "vehicleModel",
  d.vehicle_color AS "vehicleColor", d.vehicle_plate AS "vehiclePlate",
  d.status,
  CASE WHEN d.current_location IS NULL THEN NULL ELSE ST_X(d.current_location::geometry) END AS lng,
  CASE WHEN d.current_location IS NULL THEN NULL ELSE ST_Y(d.current_location::geometry) END AS lat,
  d.last_updated_at AS "lastUpdatedAt", d.created_at AS "createdAt"
`;

// Bulk position update for a whole batch window's worth of drivers in a single round trip
// (via UNNEST over parallel arrays), instead of one UPDATE per driver — see
// docs/ws-batching-and-compression.md for why this matters at fleet scale.
export async function batchUpdateLocations(entries: BatchLocationEntry[]): Promise<Driver[]> {
  if (entries.length === 0) return [];

  const ids = entries.map((e) => e.id);
  const lats = entries.map((e) => e.lat);
  const lngs = entries.map((e) => e.lng);

  const { rows } = await pool.query<DriverRow>(
    `UPDATE drivers d
     SET current_location = ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography,
         last_updated_at = now()
     FROM UNNEST($1::uuid[], $2::double precision[], $3::double precision[]) AS v(id, lng, lat)
     WHERE d.id = v.id
     RETURNING ${BATCH_SELECT_COLUMNS}`,
    [ids, lngs, lats],
  );
  return rows.map(mapRow);
}

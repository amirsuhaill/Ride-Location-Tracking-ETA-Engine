import * as driversRepo from "../repositories/drivers.repository";
import type { Driver } from "../repositories/drivers.repository";
import * as driversGeoRepo from "../repositories/drivers.geo.repository";
import type { NearbyDriver } from "../repositories/drivers.geo.repository";
import { NotFoundError, ConflictError } from "../errors";
import type { CreateDriverInput, DriverStatus } from "../schemas/drivers";

// Legal driver status transitions:
//   offline -> online   (driver comes on shift)
//   online  -> offline  (driver ends shift)
//   online  -> busy     (assigned a trip)
//   busy    -> online   (trip finished, driver free again)
// offline -> busy and busy -> offline are both illegal: a driver can't be assigned a trip
// without first going online, and can't drop offline mid-trip without freeing up first. A
// status "transition" to its own current value is a no-op success, not a conflict.
const LEGAL_TRANSITIONS: Record<DriverStatus, ReadonlySet<DriverStatus>> = {
  offline: new Set<DriverStatus>(["offline", "online"]),
  online: new Set<DriverStatus>(["online", "offline", "busy"]),
  busy: new Set<DriverStatus>(["busy", "online"]),
};

export async function createDriver(input: CreateDriverInput): Promise<Driver> {
  return driversRepo.insertDriver(input);
}

export async function getDriver(id: string): Promise<Driver> {
  const driver = await driversRepo.findDriverById(id);
  if (!driver) throw new NotFoundError(`Driver ${id} not found`);
  return driver;
}

export async function updateDriverStatus(id: string, nextStatus: DriverStatus): Promise<Driver> {
  const driver = await driversRepo.findDriverById(id);
  if (!driver) throw new NotFoundError(`Driver ${id} not found`);

  if (!LEGAL_TRANSITIONS[driver.status].has(nextStatus)) {
    throw new ConflictError(
      `Cannot transition driver status from '${driver.status}' to '${nextStatus}'`,
    );
  }

  const updated = await driversRepo.updateDriverStatus(id, nextStatus);
  if (!updated) throw new NotFoundError(`Driver ${id} not found`);

  // Mirror into the live Redis view. Postgres remains authoritative; this just keeps
  // /drivers/nearby's online/offline filter in sync with the durable status we just wrote.
  await driversGeoRepo.updateDriverStatusInRedis(id, nextStatus);

  return updated;
}

export async function updateDriverLocation(id: string, lat: number, lng: number): Promise<Driver> {
  const driver = await driversRepo.findDriverById(id);
  if (!driver) throw new NotFoundError(`Driver ${id} not found`);

  const updated = await driversRepo.updateDriverLocation(id, lat, lng);
  if (!updated) throw new NotFoundError(`Driver ${id} not found`);

  // Postgres (durable) is updated first, then Redis (live) — a location "update" is exactly the
  // event that keeps a driver visible/fresh in nearby search.
  await driversGeoRepo.upsertDriverLocation(id, lat, lng, updated.status);

  return updated;
}

export async function searchNearbyDrivers(
  lat: number,
  lng: number,
  radiusMeters: number,
  limit: number,
): Promise<NearbyDriver[]> {
  return driversGeoRepo.searchNearby(lat, lng, radiusMeters, limit);
}

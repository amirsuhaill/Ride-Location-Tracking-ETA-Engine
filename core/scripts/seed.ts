import { faker } from "@faker-js/faker";
import { v5 as uuidv5 } from "uuid";
import { pool } from "../src/db";

// Fixed namespace + deterministic per-row names => deterministic ids, so re-running this script
// upserts the same 20 drivers / 8 riders instead of inserting duplicates or racing a unique
// constraint. This is what makes the seed idempotent without adding a separate "seed_key" column.
const SEED_NAMESPACE = "9c1f1b7e-4b39-4b6e-9c39-9f7a9f2e3b10";

const DRIVER_COUNT = 20;
const RIDER_COUNT = 8;

// San Francisco proper bounding box.
const SF_BBOX = {
  minLat: 37.708,
  maxLat: 37.812,
  minLng: -122.514,
  maxLng: -122.386,
};

const DRIVER_STATUS_WEIGHTS: Array<"online" | "offline" | "busy"> = [
  "online",
  "online",
  "online",
  "busy",
  "offline",
];

// Small seeded PRNG (mulberry32) so lat/lng/status are reproducible across runs, independent of
// faker's own seeded sequence (which drives names/vehicle info).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);

function randomInBbox(): { lat: number; lng: number } {
  const lat = SF_BBOX.minLat + rng() * (SF_BBOX.maxLat - SF_BBOX.minLat);
  const lng = SF_BBOX.minLng + rng() * (SF_BBOX.maxLng - SF_BBOX.minLng);
  return { lat, lng };
}

function pick<T>(items: T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick() called with empty array");
  return item;
}

async function seedDrivers(): Promise<void> {
  faker.seed(42);

  for (let i = 0; i < DRIVER_COUNT; i++) {
    const id = uuidv5(`driver-${i}`, SEED_NAMESPACE);
    const { lat, lng } = randomInBbox();
    const status = pick(DRIVER_STATUS_WEIGHTS);

    await pool.query(
      `INSERT INTO drivers
         (id, name, vehicle_make, vehicle_model, vehicle_color, vehicle_plate, status, current_location, last_updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         vehicle_make = EXCLUDED.vehicle_make,
         vehicle_model = EXCLUDED.vehicle_model,
         vehicle_color = EXCLUDED.vehicle_color,
         vehicle_plate = EXCLUDED.vehicle_plate,
         status = EXCLUDED.status,
         current_location = EXCLUDED.current_location,
         last_updated_at = now()`,
      [
        id,
        faker.person.fullName(),
        faker.vehicle.manufacturer(),
        faker.vehicle.model(),
        faker.color.human(),
        faker.vehicle.vrm(),
        status,
        lng,
        lat,
      ],
    );
  }
}

async function seedRiders(): Promise<void> {
  faker.seed(1042);

  for (let i = 0; i < RIDER_COUNT; i++) {
    const id = uuidv5(`rider-${i}`, SEED_NAMESPACE);

    await pool.query(
      `INSERT INTO riders (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [id, faker.person.fullName()],
    );
  }
}

async function main(): Promise<void> {
  await seedDrivers();
  await seedRiders();

  const { rows: driverRows } = await pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM drivers",
  );
  const { rows: riderRows } = await pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM riders",
  );

  console.log(
    `Seeded/updated ${DRIVER_COUNT} drivers, ${RIDER_COUNT} riders. ` +
      `Table totals: drivers=${driverRows[0]?.count}, riders=${riderRows[0]?.count}.`,
  );
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

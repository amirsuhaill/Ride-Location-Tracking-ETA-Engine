import { pool } from "../src/db";
import { RUSH_HOUR_TABLE } from "../src/services/eta-heuristic";
import {
  DEFAULT_SIMULATOR_CONFIG,
  generateTrips,
  type SimulatedTrip,
  type SimulatorConfig,
} from "./lib/trip-simulator";

const INSERT_BATCH_SIZE = 500;

// generateTrips (scripts/lib/trip-simulator.ts) builds requestedAt via local Date getters/setters
// and getRushHourMultiplier reads Date.prototype.getHours() — both evaluated in this process's
// local time, which is pinned to America/Los_Angeles for this project (core/.env, docs/eta.md).
// Postgres timestamptz columns are stored in UTC and EXTRACT(HOUR FROM ...) reads back in the
// *session's* timezone (UTC by default, not this process's), so the hourly summary below must
// explicitly convert back to the same zone generation used — otherwise the reported hour-of-day
// is off by the Pacific/UTC offset (~7-8h) and the rush-hour signal appears in the wrong buckets.
const SIMULATION_TIME_ZONE = "America/Los_Angeles";

function parseEndDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`SIM_END_DATE must be YYYY-MM-DD, got: ${value}`);
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function loadConfig(): SimulatorConfig {
  return {
    ...DEFAULT_SIMULATOR_CONFIG,
    seed: Number(process.env.SIM_SEED ?? DEFAULT_SIMULATOR_CONFIG.seed),
    tripCount: Number(process.env.SIM_TRIP_COUNT ?? DEFAULT_SIMULATOR_CONFIG.tripCount),
    days: Number(process.env.SIM_DAYS ?? DEFAULT_SIMULATOR_CONFIG.days),
    endDate: parseEndDate(process.env.SIM_END_DATE, DEFAULT_SIMULATOR_CONFIG.endDate),
  };
}

function isRushHour(hour: number): boolean {
  return RUSH_HOUR_TABLE.some((w) => hour >= w.startHour && hour < w.endHour);
}

export async function deletePriorRun(seed: number): Promise<void> {
  await pool.query("DELETE FROM training_trips WHERE simulation_seed = $1", [seed]);
}

export async function insertTrips(trips: SimulatedTrip[], seed: number): Promise<void> {
  for (let start = 0; start < trips.length; start += INSERT_BATCH_SIZE) {
    const batch = trips.slice(start, start + INSERT_BATCH_SIZE);

    const pickupLngs = batch.map((t) => t.pickup.lng);
    const pickupLats = batch.map((t) => t.pickup.lat);
    const dropoffLngs = batch.map((t) => t.dropoff.lng);
    const dropoffLats = batch.map((t) => t.dropoff.lat);
    const requestedAts = batch.map((t) => t.requestedAt);
    const naiveDistances = batch.map((t) => t.naiveDistanceMeters);
    const naiveDurations = batch.map((t) => t.naiveDurationSeconds);
    const actualDistances = batch.map((t) => t.actualDistanceMeters);
    const actualDurations = batch.map((t) => t.actualDurationSeconds);
    const timeMultipliers = batch.map((t) => t.timeOfDayMultiplier);
    const densityFactors = batch.map((t) => t.zoneDensityFactor);
    const noiseFactors = batch.map((t) => t.noiseFactor);
    const seeds = batch.map(() => seed);

    await pool.query(
      `INSERT INTO training_trips (
         pickup_location, dropoff_location, requested_at,
         naive_distance_meters, naive_duration_seconds,
         actual_distance_meters, actual_duration_seconds,
         time_of_day_multiplier, zone_density_factor, noise_factor,
         simulation_seed
       )
       SELECT
         ST_SetSRID(ST_MakePoint(v.pickup_lng, v.pickup_lat), 4326)::geography,
         ST_SetSRID(ST_MakePoint(v.dropoff_lng, v.dropoff_lat), 4326)::geography,
         v.requested_at,
         v.naive_distance_meters, v.naive_duration_seconds,
         v.actual_distance_meters, v.actual_duration_seconds,
         v.time_of_day_multiplier, v.zone_density_factor, v.noise_factor,
         v.simulation_seed
       FROM UNNEST(
         $1::double precision[], $2::double precision[],
         $3::double precision[], $4::double precision[],
         $5::timestamptz[],
         $6::double precision[], $7::double precision[],
         $8::double precision[], $9::double precision[],
         $10::double precision[], $11::double precision[], $12::double precision[],
         $13::integer[]
       ) AS v(
         pickup_lng, pickup_lat, dropoff_lng, dropoff_lat, requested_at,
         naive_distance_meters, naive_duration_seconds,
         actual_distance_meters, actual_duration_seconds,
         time_of_day_multiplier, zone_density_factor, noise_factor,
         simulation_seed
       )`,
      [
        pickupLngs,
        pickupLats,
        dropoffLngs,
        dropoffLats,
        requestedAts,
        naiveDistances,
        naiveDurations,
        actualDistances,
        actualDurations,
        timeMultipliers,
        densityFactors,
        noiseFactors,
        seeds,
      ],
    );
  }
}

interface SummaryRow {
  row_count: number;
  min_date: Date | null;
  max_date: Date | null;
  avg_actual_duration: string | null;
  avg_naive_duration: string | null;
}

interface HourlyRow {
  hour: number;
  trip_count: number;
  avg_duration_seconds: string;
  avg_speed_mps: string;
}

export async function printSummary(seed: number): Promise<void> {
  const { rows: summaryRows } = await pool.query<SummaryRow>(
    `SELECT
       count(*)::int AS row_count,
       min(requested_at) AS min_date,
       max(requested_at) AS max_date,
       avg(actual_duration_seconds) AS avg_actual_duration,
       avg(naive_duration_seconds) AS avg_naive_duration
     FROM training_trips
     WHERE simulation_seed = $1`,
    [seed],
  );
  const summary = summaryRows[0]!;

  const { rows: hourlyRows } = await pool.query<HourlyRow>(
    `SELECT
       extract(hour FROM requested_at AT TIME ZONE $2)::int AS hour,
       count(*)::int AS trip_count,
       avg(actual_duration_seconds) AS avg_duration_seconds,
       avg(actual_distance_meters / actual_duration_seconds) AS avg_speed_mps
     FROM training_trips
     WHERE simulation_seed = $1
     GROUP BY hour
     ORDER BY hour`,
    [seed, SIMULATION_TIME_ZONE],
  );

  console.log("\n=== Historical trip simulator summary ===");
  console.log(`simulation_seed:     ${seed}`);
  console.log(`row count:           ${summary.row_count}`);
  console.log(
    `date range:          ${summary.min_date?.toISOString()} .. ${summary.max_date?.toISOString()}`,
  );
  console.log(`avg actual duration: ${Number(summary.avg_actual_duration).toFixed(1)}s`);
  console.log(`avg naive duration:  ${Number(summary.avg_naive_duration).toFixed(1)}s`);

  console.log("\nDuration/speed by hour-of-day:");
  console.log("hour | trips | avg duration (s) | avg speed (m/s)");
  for (const row of hourlyRows) {
    const rushFlag = isRushHour(row.hour) ? " <- rush hour" : "";
    console.log(
      `${String(row.hour).padStart(4)} | ${String(row.trip_count).padStart(5)} | ` +
        `${Number(row.avg_duration_seconds).toFixed(1).padStart(16)} | ` +
        `${Number(row.avg_speed_mps).toFixed(2).padStart(15)}${rushFlag}`,
    );
  }

  const rushRows = hourlyRows.filter((r) => isRushHour(r.hour));
  const offPeakRows = hourlyRows.filter((r) => !isRushHour(r.hour));

  const weightedAvg = (rows: HourlyRow[], field: "avg_duration_seconds" | "avg_speed_mps"): number => {
    let weightedSum = 0;
    let totalCount = 0;
    for (const row of rows) {
      const count = Number(row.trip_count);
      weightedSum += Number(row[field]) * count;
      totalCount += count;
    }
    return totalCount === 0 ? 0 : weightedSum / totalCount;
  };

  const rushAvgDuration = weightedAvg(rushRows, "avg_duration_seconds");
  const offPeakAvgDuration = weightedAvg(offPeakRows, "avg_duration_seconds");
  const rushAvgSpeed = weightedAvg(rushRows, "avg_speed_mps");
  const offPeakAvgSpeed = weightedAvg(offPeakRows, "avg_speed_mps");

  const durationPctDiff = ((rushAvgDuration - offPeakAvgDuration) / offPeakAvgDuration) * 100;
  const speedPctDiff = ((rushAvgSpeed - offPeakAvgSpeed) / offPeakAvgSpeed) * 100;

  console.log("\nRush hour vs off-peak (weighted by trip count):");
  console.log(
    `  avg duration: rush=${rushAvgDuration.toFixed(1)}s  off-peak=${offPeakAvgDuration.toFixed(1)}s  ` +
      `(${durationPctDiff >= 0 ? "+" : ""}${durationPctDiff.toFixed(1)}%)`,
  );
  console.log(
    `  avg speed:    rush=${rushAvgSpeed.toFixed(2)}m/s  off-peak=${offPeakAvgSpeed.toFixed(2)}m/s  ` +
      `(${speedPctDiff.toFixed(1)}%)`,
  );

  const SIGNAL_THRESHOLD_PCT = 15;
  if (durationPctDiff >= SIGNAL_THRESHOLD_PCT) {
    console.log(
      `  PASS: rush-hour avg duration is ${durationPctDiff.toFixed(1)}% higher than off-peak ` +
        `(>= ${SIGNAL_THRESHOLD_PCT}% threshold) — visible signal present.`,
    );
  } else {
    console.log(
      `  WARNING: rush-hour avg duration is only ${durationPctDiff.toFixed(1)}% higher than ` +
        `off-peak (< ${SIGNAL_THRESHOLD_PCT}% threshold) — signal may be too weak.`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(
    `Generating ${config.tripCount} trips (seed=${config.seed}, days=${config.days}, ` +
      `endDate=${config.endDate.toISOString()})...`,
  );
  const trips = generateTrips(config);

  await deletePriorRun(config.seed);
  await insertTrips(trips, config.seed);

  await printSummary(config.seed);
}

// Guarded so this module can be imported (e.g. from tests, for insertTrips/printSummary) without
// immediately running the full simulation against whatever DATABASE_URL happens to be configured.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error("Simulation failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

import { config } from "../config";
import { precisionForRadius } from "../geo/geohash";

// Same reference point used throughout this project for city-scale geo defaults (SF, Union
// Square/Financial District-ish — core/scripts/lib/trip-simulator.ts, ml-service's
// app/ml/constants.py). Only used to convert a real-world zone radius into a bit precision
// (longitude cell width depends on latitude) — not a claim that all zones are literally
// centered there.
const REFERENCE_LAT = 37.7749;

export interface SurgeRuntimeConfig {
  /** Geohash bit precision defining a "zone" (see docs/surge-pricing.md) — derived from
   * config.surgeZoneRadiusMeters via Phase 12's precisionForRadius, not a raw magic bit count. */
  zoneBits: number;
  updateIntervalMs: number;
  minMultiplier: number;
  maxMultiplier: number;
  minSampleRequests: number;
  maxChangePerInterval: number;
}

let runtimeConfig: SurgeRuntimeConfig = {
  zoneBits: precisionForRadius(config.surgeZoneRadiusMeters, REFERENCE_LAT),
  updateIntervalMs: config.surgeUpdateIntervalMs,
  minMultiplier: config.surgeMinMultiplier,
  maxMultiplier: config.surgeMaxMultiplier,
  minSampleRequests: config.surgeMinSampleRequests,
  maxChangePerInterval: config.surgeMaxChangePerInterval,
};

export function configureSurge(overrides: Partial<SurgeRuntimeConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...overrides };
}

export function getSurgeConfig(): SurgeRuntimeConfig {
  return runtimeConfig;
}

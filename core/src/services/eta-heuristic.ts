import { haversineDistanceMeters, type LatLng } from "./haversine";

export interface RushHourWindow {
  /** Local hour of day, 0-23, inclusive start. */
  startHour: number;
  /** Local hour of day, 0-23, exclusive end. */
  endHour: number;
  /** ETA multiplier applied when the current hour falls in this window (>1 = slower). */
  multiplier: number;
}

// Table-driven, not inline conditionals — see docs/eta.md for why this lives as a named,
// documented constant rather than an env var (a list of {start, end, multiplier} windows has no
// natural flat env-var shape).
//
// These are PLACEHOLDER estimates, not calibrated to any real traffic data for this project
// (there is none yet — no live GPS/traffic feed exists). Loosely based on commonly-cited US
// urban commute congestion research (e.g. INRIX / Texas A&M Transportation Institute-style
// findings that peak-hour congestion typically adds 30-60% to free-flow travel time in major
// metro areas): a smaller morning bump and a larger evening bump, since evening commutes
// typically spread over a longer, worse window than the morning commute. Replace with real
// measured multipliers once trip data exists (Phase 8+).
export const RUSH_HOUR_TABLE: RushHourWindow[] = [
  { startHour: 7, endHour: 9, multiplier: 1.4 }, // morning commute
  { startHour: 16, endHour: 19, multiplier: 1.5 }, // evening commute
];
export const DEFAULT_MULTIPLIER = 1.0;

/**
 * Evaluated in the server process's local time (`Date.prototype.getHours()`) — a known
 * limitation for a multi-timezone deployment, but fine for this project's single-city (SF)
 * baseline: the core service's `TZ` is set to `America/Los_Angeles` (see infra/docker-compose.yml
 * and core/.env) specifically so this table lines up with the seeded data's actual local time,
 * rather than silently evaluating rush hour in UTC.
 */
export function getRushHourMultiplier(
  atTime: Date,
  table: RushHourWindow[] = RUSH_HOUR_TABLE,
): number {
  const hour = atTime.getHours();
  for (const window of table) {
    if (hour >= window.startHour && hour < window.endHour) return window.multiplier;
  }
  return DEFAULT_MULTIPLIER;
}

export interface EtaEstimate {
  etaSeconds: number;
  distanceMeters: number;
}

export interface EtaHeuristicConfig {
  avgSpeedMetersPerSecond: number;
}

/** distance / configurable average speed, adjusted by the table-driven rush-hour multiplier. */
export function estimateEta(
  from: LatLng,
  to: LatLng,
  atTime: Date,
  config: EtaHeuristicConfig,
): EtaEstimate {
  const distanceMeters = haversineDistanceMeters(from, to);
  const baseEtaSeconds = distanceMeters / config.avgSpeedMetersPerSecond;
  const multiplier = getRushHourMultiplier(atTime);
  return { etaSeconds: baseEtaSeconds * multiplier, distanceMeters };
}

import { LAT_MAX, LAT_MIN, LNG_MAX, LNG_MIN } from "./constants";

/**
 * Real bounds, matching core's own schemas exactly (constants.ts) — a "needs a person to act"
 * case (Frontend Phase 8, docs/frontend-resilience.md), not a transient failure worth retrying:
 * typing 200 for latitude will *always* be wrong, no amount of retrying the request changes that,
 * so this is caught immediately, client-side, before any network round-trip is even attempted —
 * both faster feedback for the person typing it and one less way to feed a downstream poll
 * (useSurgeAtPoint) a coordinate that would 400 on every single attempt.
 */
export function validate(latText: string, lngText: string): string | null {
  // `Number("")` is 0, not NaN — an empty field must not silently become a real coordinate.
  if (latText.trim() === "" || lngText.trim() === "") {
    return "Enter a valid number for both latitude and longitude.";
  }
  const lat = Number(latText);
  const lng = Number(lngText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "Enter a valid number for both latitude and longitude.";
  }
  if (lat < LAT_MIN || lat > LAT_MAX) {
    return `Latitude must be between ${LAT_MIN} and ${LAT_MAX}.`;
  }
  if (lng < LNG_MIN || lng > LNG_MAX) {
    return `Longitude must be between ${LNG_MIN} and ${LNG_MAX}.`;
  }
  return null;
}

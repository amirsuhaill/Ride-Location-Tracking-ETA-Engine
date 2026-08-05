import { SURGE_MAX_MULTIPLIER, SURGE_MIN_MULTIPLIER } from "./constants";

/** How far `multiplier` sits between baseline and the ceiling, as 0..1 — clamped, so a value
 * that ever briefly overshoots (shouldn't happen given the backend's own clamping, but this is
 * rendering code, not the source of truth) never produces an out-of-range color or an
 * over-100%-intense fill. */
export function surgeIntensity(
  multiplier: number,
  min: number = SURGE_MIN_MULTIPLIER,
  max: number = SURGE_MAX_MULTIPLIER,
): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (multiplier - min) / (max - min)));
}

const BASELINE_RGB = { r: 253, g: 224, b: 71 }; // pale amber — 1.0x, "nothing unusual here"
const CEILING_RGB = { r: 185, g: 28, b: 28 }; // deep red — at/near MAX_MULTIPLIER

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Color alone is never the only signal (a numeric label is always rendered alongside — see
 * SurgeOverlay.tsx) but it still needs to carry real information for sighted users: pale amber at
 * baseline, deepening to red as the multiplier climbs toward the real MAX_MULTIPLIER, not an
 * arbitrary palette. */
export function surgeFillColor(
  multiplier: number,
  min: number = SURGE_MIN_MULTIPLIER,
  max: number = SURGE_MAX_MULTIPLIER,
): string {
  const t = surgeIntensity(multiplier, min, max);
  const r = lerp(BASELINE_RGB.r, CEILING_RGB.r, t);
  const g = lerp(BASELINE_RGB.g, CEILING_RGB.g, t);
  const b = lerp(BASELINE_RGB.b, CEILING_RGB.b, t);
  return `rgb(${r}, ${g}, ${b})`;
}

const MIN_FILL_OPACITY = 0.2;
const MAX_FILL_OPACITY = 0.7;

/** A second, independent channel of "how intense" (opacity), on top of the color itself — purely
 * additive visual signal; the numeric label is what actually carries the information for anyone
 * who can't distinguish either. */
export function surgeFillOpacity(
  multiplier: number,
  min: number = SURGE_MIN_MULTIPLIER,
  max: number = SURGE_MAX_MULTIPLIER,
): number {
  const t = surgeIntensity(multiplier, min, max);
  return MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * t;
}

/** The one place a surge multiplier is ever formatted for display — e.g. 1 -> "1.0x",
 * 2.83 -> "2.8x" — one decimal place, matching docs/surge-pricing.md's own "1.4x" convention. */
export function formatMultiplier(multiplier: number): string {
  return `${multiplier.toFixed(1)}x`;
}

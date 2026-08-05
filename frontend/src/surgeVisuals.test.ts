import { describe, expect, it } from "vitest";
import { formatMultiplier, surgeFillColor, surgeFillOpacity, surgeIntensity } from "./surgeVisuals";

const MIN = 1.0;
const MAX = 3.0;

describe("surgeVisuals: surgeIntensity", () => {
  it("is exactly 0 at the baseline multiplier", () => {
    expect(surgeIntensity(MIN, MIN, MAX)).toBe(0);
  });

  it("is exactly 1 at the ceiling multiplier", () => {
    expect(surgeIntensity(MAX, MIN, MAX)).toBe(1);
  });

  it("is 0.5 exactly halfway between baseline and ceiling", () => {
    expect(surgeIntensity(2.0, MIN, MAX)).toBe(0.5);
  });

  it("clamps below baseline to 0 rather than going negative", () => {
    expect(surgeIntensity(0.5, MIN, MAX)).toBe(0);
  });

  it("clamps above the ceiling to 1 rather than exceeding it", () => {
    expect(surgeIntensity(5, MIN, MAX)).toBe(1);
  });

  it("never divides by zero when min and max coincide", () => {
    expect(surgeIntensity(1.0, 1.0, 1.0)).toBe(0);
  });
});

describe("surgeVisuals: surgeFillColor", () => {
  it("is the pale-amber baseline color at 1.0x", () => {
    expect(surgeFillColor(MIN, MIN, MAX)).toBe("rgb(253, 224, 71)");
  });

  it("is the deep-red ceiling color at 3.0x", () => {
    expect(surgeFillColor(MAX, MIN, MAX)).toBe("rgb(185, 28, 28)");
  });

  it("is a real, distinct color in between at a mid-range multiplier", () => {
    const baseline = surgeFillColor(MIN, MIN, MAX);
    const ceiling = surgeFillColor(MAX, MIN, MAX);
    const mid = surgeFillColor(2.0, MIN, MAX);
    expect(mid).not.toBe(baseline);
    expect(mid).not.toBe(ceiling);
  });
});

describe("surgeVisuals: surgeFillOpacity", () => {
  it("is lower at baseline than at the ceiling", () => {
    expect(surgeFillOpacity(MIN, MIN, MAX)).toBeLessThan(surgeFillOpacity(MAX, MIN, MAX));
  });

  it("stays within the documented [0.2, 0.7] range across the full multiplier range", () => {
    for (const m of [MIN, 1.5, 2.0, 2.5, MAX]) {
      const opacity = surgeFillOpacity(m, MIN, MAX);
      expect(opacity).toBeGreaterThanOrEqual(0.2);
      expect(opacity).toBeLessThanOrEqual(0.7);
    }
  });
});

describe("surgeVisuals: formatMultiplier", () => {
  it("formats an exact baseline multiplier as 1.0x", () => {
    expect(formatMultiplier(1)).toBe("1.0x");
  });

  it("formats an exact ceiling multiplier as 3.0x", () => {
    expect(formatMultiplier(3)).toBe("3.0x");
  });

  it("rounds to exactly one decimal place, matching docs/surge-pricing.md's convention", () => {
    expect(formatMultiplier(2.83)).toBe("2.8x");
    expect(formatMultiplier(1.44)).toBe("1.4x");
  });
});

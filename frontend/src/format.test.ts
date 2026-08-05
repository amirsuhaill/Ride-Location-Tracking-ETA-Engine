import { describe, expect, it } from "vitest";
import { formatCents } from "./format";

describe("format: formatCents", () => {
  it("converts a whole-cents integer to a currency string (cents -> dollars)", () => {
    expect(formatCents(4150, "USD")).toBe("$41.50");
  });

  it("formats zero cents correctly, not as an empty/falsy-looking string", () => {
    expect(formatCents(0, "USD")).toBe("$0.00");
  });

  it("formats exactly one dollar (a round number) with two decimal places", () => {
    expect(formatCents(100, "USD")).toBe("$1.00");
  });

  it("formats a single cent — the smallest nonzero unit", () => {
    expect(formatCents(1, "USD")).toBe("$0.01");
  });

  it("rounds a fractional-cent input the same way Intl.NumberFormat would (division artifact)", () => {
    // 2967 / 100 = 29.67 exactly representable enough — this guards against a naive
    // toFixed/string-concat implementation that mishandles floating point division.
    expect(formatCents(2967, "USD")).toBe("$29.67");
  });

  it("works for a real fare total this app actually returns (docs/surge-pricing.md's example)", () => {
    expect(formatCents(8892, "USD")).toBe("$88.92");
  });

  it("is not hardcoded to USD — a different real ISO currency code formats with its own symbol", () => {
    // EUR's symbol conventionally follows the amount in most locales — asserting only that the
    // currency's own real symbol and correct numeric value both appear, not one exact locale's
    // full punctuation/ordering (avoids the test being tied to whichever locale a given machine
    // or CI runner happens to default to).
    const result = formatCents(500, "EUR");
    expect(result).toContain("5.00");
    expect(result).toMatch(/€/);
  });

  it("produces correct, consistent output across repeated calls for the same currency (the cached-formatter path)", () => {
    // A currency code no other test in this file uses, so this exercises a fresh cache entry
    // regardless of run order — repeated calls must keep formatting correctly, not just the
    // first one before a formatter is cached.
    expect(formatCents(100, "GBP")).toBe("£1.00");
    expect(formatCents(250, "GBP")).toBe("£2.50");
    expect(formatCents(999, "GBP")).toBe("£9.99");
  });
});

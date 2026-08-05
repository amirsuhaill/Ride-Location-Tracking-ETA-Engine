import { describe, expect, it } from "vitest";
import { validate } from "./coordinateValidation";

describe("coordinateValidation: validate", () => {
  it("accepts a real, in-range coordinate", () => {
    expect(validate("37.7749", "-122.4194")).toBeNull();
  });

  it("accepts the exact boundary values", () => {
    expect(validate("90", "180")).toBeNull();
    expect(validate("-90", "-180")).toBeNull();
  });

  it("rejects a non-numeric latitude", () => {
    expect(validate("not a number", "-122.4194")).toBe(
      "Enter a valid number for both latitude and longitude.",
    );
  });

  it("rejects an empty longitude", () => {
    expect(validate("37.7749", "")).toBe("Enter a valid number for both latitude and longitude.");
  });

  it("rejects a latitude past the real bound, matching core's own schema message shape", () => {
    expect(validate("200", "-122.4194")).toBe("Latitude must be between -90 and 90.");
  });

  it("rejects a longitude past the real bound", () => {
    expect(validate("37.7749", "300")).toBe("Longitude must be between -180 and 180.");
  });

  it("checks latitude before longitude when both are invalid", () => {
    expect(validate("200", "300")).toBe("Latitude must be between -90 and 90.");
  });
});

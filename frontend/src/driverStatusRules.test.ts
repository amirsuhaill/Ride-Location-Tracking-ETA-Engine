import { describe, expect, it } from "vitest";
import { canTransitionDriverStatus } from "./driverStatusRules";

describe("canTransitionDriverStatus (mirrors docs/API.md's legal-transition table)", () => {
  it("offline -> online is legal", () => {
    expect(canTransitionDriverStatus("offline", "online")).toBe(true);
  });
  it("offline -> busy is illegal", () => {
    expect(canTransitionDriverStatus("offline", "busy")).toBe(false);
  });
  it("online -> offline is legal", () => {
    expect(canTransitionDriverStatus("online", "offline")).toBe(true);
  });
  it("online -> busy is legal", () => {
    expect(canTransitionDriverStatus("online", "busy")).toBe(true);
  });
  it("busy -> online is legal", () => {
    expect(canTransitionDriverStatus("busy", "online")).toBe(true);
  });
  it("busy -> offline is illegal", () => {
    expect(canTransitionDriverStatus("busy", "offline")).toBe(false);
  });
  it("every status to itself is a legal no-op", () => {
    expect(canTransitionDriverStatus("online", "online")).toBe(true);
    expect(canTransitionDriverStatus("offline", "offline")).toBe(true);
    expect(canTransitionDriverStatus("busy", "busy")).toBe(true);
  });
});

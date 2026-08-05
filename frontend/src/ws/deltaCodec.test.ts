import { describe, expect, it } from "vitest";
import {
  decodeLocationMessage,
  QUANTIZATION_STEP_DEGREES,
  type LastKnownState,
  type LatLng,
  type LocationBroadcastMessage,
} from "./deltaCodec";

/**
 * A minimal test-only mirror of core/src/ws/delta-compression.ts#encodeLocationMessage — just
 * enough to generate realistic server-shaped messages for these decode tests. The actual
 * production code under test is `decodeLocationMessage`, imported for real above; this helper
 * only exists so the tests don't have to hand-construct quantized delta integers by hand.
 */
function encodeForTest(
  lastSent: LastKnownState | null,
  current: LatLng,
  meta: { driverId: string; timestamp: number; status: LastKnownState["status"] },
): LocationBroadcastMessage {
  if (!lastSent) {
    return {
      type: "location",
      driverId: meta.driverId,
      lat: current.lat,
      lng: current.lng,
      timestamp: meta.timestamp,
      status: meta.status,
    };
  }
  return {
    type: "delta",
    driverId: meta.driverId,
    dLat: Math.round((current.lat - lastSent.lat) / QUANTIZATION_STEP_DEGREES),
    dLng: Math.round((current.lng - lastSent.lng) / QUANTIZATION_STEP_DEGREES),
    timestamp: meta.timestamp,
    ...(meta.status !== lastSent.status ? { status: meta.status } : {}),
  };
}

describe("deltaCodec: decodeLocationMessage", () => {
  const meta = { driverId: "d1", timestamp: 123, status: "online" as const };

  it("a full 'location' message decodes to an exact position, no prior state needed", () => {
    const message = encodeForTest(null, { lat: 37.77, lng: -122.42 }, meta);
    expect(message.type).toBe("location");

    const decoded = decodeLocationMessage(null, message);
    expect(decoded).toEqual({ lat: 37.77, lng: -122.42, status: "online" });
  });

  it("a delta message decodes within the documented ~0.71m worst-case error bound", () => {
    const first: LastKnownState = { lat: 37.7749, lng: -122.4194, status: "online" };
    const target: LatLng = { lat: 37.7755, lng: -122.4201 };

    const message = encodeForTest(first, target, meta);
    const decoded = decodeLocationMessage(first, message);

    // Per-axis bound: half a quantization step (docs/ws-batching-and-compression.md).
    expect(Math.abs(decoded.lat - target.lat)).toBeLessThanOrEqual(QUANTIZATION_STEP_DEGREES / 2);
    expect(Math.abs(decoded.lng - target.lng)).toBeLessThanOrEqual(QUANTIZATION_STEP_DEGREES / 2);

    // Combined radial bound, same derivation as the doc: sqrt(0.56^2 + 0.44^2) ~= 0.71m at SF's
    // latitude — computed here from first principles, not copied as a magic number.
    const metersPerDegreeLat = 111_320;
    const metersPerDegreeLng = 111_320 * Math.cos((first.lat * Math.PI) / 180);
    const latErrorMeters = (QUANTIZATION_STEP_DEGREES / 2) * metersPerDegreeLat;
    const lngErrorMeters = (QUANTIZATION_STEP_DEGREES / 2) * metersPerDegreeLng;
    const worstCaseRadialMeters = Math.sqrt(latErrorMeters ** 2 + lngErrorMeters ** 2);
    expect(worstCaseRadialMeters).toBeLessThan(0.71 + 0.01); // matches the doc's ~0.71m derivation

    const latErrorMetersActual = Math.abs(decoded.lat - target.lat) * metersPerDegreeLat;
    const lngErrorMetersActual = Math.abs(decoded.lng - target.lng) * metersPerDegreeLng;
    const actualRadialMeters = Math.sqrt(latErrorMetersActual ** 2 + lngErrorMetersActual ** 2);
    expect(actualRadialMeters).toBeLessThanOrEqual(worstCaseRadialMeters);
  });

  it("carries the last known status forward when a delta omits it", () => {
    const first: LastKnownState = { lat: 37.7749, lng: -122.4194, status: "busy" };
    const message = encodeForTest(first, { lat: 37.776, lng: -122.42 }, meta); // meta.status: "online", differs
    expect("status" in message).toBe(true); // status changed, so it IS included this time

    // Now decode a SECOND delta that doesn't change status — status must carry forward.
    const decodedFirst = decodeLocationMessage(first, message);
    const noStatusChangeMessage: LocationBroadcastMessage = {
      type: "delta",
      driverId: "d1",
      dLat: 1,
      dLng: -1,
      timestamp: 124,
      // no status field — unchanged since last sent
    };
    const decodedSecond = decodeLocationMessage(decodedFirst, noStatusChangeMessage);
    expect(decodedSecond.status).toBe(decodedFirst.status);
  });

  it("a chain of 10+ real delta messages does not accumulate error beyond the single-hop bound", () => {
    let serverTruth: LatLng = { lat: 37.7749, lng: -122.4194 };
    let lastSent: LastKnownState | null = null;
    let clientReconstructed: LastKnownState | null = null;

    for (let i = 0; i < 15; i++) {
      serverTruth = { lat: serverTruth.lat + 0.0001, lng: serverTruth.lng - 0.0001 };
      const message = encodeForTest(lastSent, serverTruth, meta);
      clientReconstructed = decodeLocationMessage(clientReconstructed, message);
      // The server always deltas against its own true absolute position, never a quantized one —
      // mirrored here so this test's fixture data is honest about what the real server does.
      lastSent = { ...serverTruth, status: meta.status };
    }

    expect(clientReconstructed).not.toBeNull();
    expect(Math.abs(clientReconstructed!.lat - serverTruth.lat)).toBeLessThanOrEqual(
      QUANTIZATION_STEP_DEGREES / 2,
    );
    expect(Math.abs(clientReconstructed!.lng - serverTruth.lng)).toBeLessThanOrEqual(
      QUANTIZATION_STEP_DEGREES / 2,
    );
  });

  it("the very first message a subscriber receives must be a full payload — a delta with no prior state throws", () => {
    const message = encodeForTest(
      { lat: 1, lng: 1, status: "online" },
      { lat: 2, lng: 2 },
      meta,
    );
    expect(message.type).toBe("delta");
    expect(() => decodeLocationMessage(null, message)).toThrow(/no prior full position/);
  });
});

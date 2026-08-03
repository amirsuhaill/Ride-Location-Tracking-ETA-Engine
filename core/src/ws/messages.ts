import { z } from "zod";
import { getWsConfig } from "./runtime-config";

// Driver -> server: {lat, lng, timestamp}. `.finite()` on top of the range checks is what
// rejects NaN/Infinity explicitly (plain z.number() already rejects NaN as an invalid_type, but
// this makes the intent self-documenting and also catches Infinity).
export const driverLocationMessageSchema = z
  .object({
    lat: z
      .number({ error: "lat is required and must be a finite number" })
      .finite("lat must be a finite number")
      .min(-90, "lat must be between -90 and 90")
      .max(90, "lat must be between -90 and 90"),
    lng: z
      .number({ error: "lng is required and must be a finite number" })
      .finite("lng must be a finite number")
      .min(-180, "lng must be between -180 and 180")
      .max(180, "lng must be between -180 and 180"),
    timestamp: z
      .number({ error: "timestamp is required and must be a finite number (epoch ms)" })
      .finite("timestamp must be a finite number (epoch ms)"),
  })
  .superRefine((data, ctx) => {
    const toleranceMs = getWsConfig().timestampToleranceMs;
    const driftMs = Math.abs(Date.now() - data.timestamp);
    if (driftMs > toleranceMs) {
      ctx.addIssue({
        code: "custom",
        path: ["timestamp"],
        message: `timestamp is too far from server time (must be within ${toleranceMs}ms; got ${driftMs}ms)`,
      });
    }
  });
export type DriverLocationMessage = z.infer<typeof driverLocationMessageSchema>;

// Rider/dispatcher -> server: subscribe to exactly one of {driverId, tripId}, or unsubscribe from
// whatever this socket is currently subscribed to.
export const clientSubscriptionMessageSchema = z
  .object({
    type: z.enum(["subscribe", "unsubscribe"]),
    driverId: z.string().uuid("driverId must be a valid UUID").optional(),
    tripId: z.string().uuid("tripId must be a valid UUID").optional(),
  })
  .refine((msg) => msg.type !== "subscribe" || Boolean(msg.driverId) !== Boolean(msg.tripId), {
    message: "subscribe requires exactly one of driverId or tripId",
  });
export type ClientSubscriptionMessage = z.infer<typeof clientSubscriptionMessageSchema>;

// Driver -> server: response to a "trip_offer" (see src/ws/trip-offers.ts and
// src/services/matching.service.ts). Distinguished from a plain location update by the presence
// of a "type" field — location updates never have one (see driverLocationMessageSchema above).
export const tripResponseMessageSchema = z.object({
  type: z.literal("trip_response"),
  tripId: z.string().uuid("tripId must be a valid UUID"),
  accept: z.boolean({ error: "accept is required and must be a boolean" }),
});
export type TripResponseMessage = z.infer<typeof tripResponseMessageSchema>;

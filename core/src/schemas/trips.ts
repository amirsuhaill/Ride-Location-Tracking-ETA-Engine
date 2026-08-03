import { z } from "zod";
import { latLngSchema } from "./common";

export const TRIP_STATUSES = [
  "requested",
  "matched",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const createTripSchema = z.object({
  riderId: z.string().uuid("riderId must be a valid UUID"),
  pickup: latLngSchema,
  dropoff: latLngSchema,
});
export type CreateTripInput = z.infer<typeof createTripSchema>;

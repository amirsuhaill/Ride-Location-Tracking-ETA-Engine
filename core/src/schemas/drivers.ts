import { z } from "zod";
import { latLngSchema } from "./common";

export const DRIVER_STATUSES = ["online", "offline", "busy"] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const createDriverSchema = z.object({
  name: z.string().min(1, "name is required"),
  vehicleMake: z.string().min(1, "vehicleMake is required"),
  vehicleModel: z.string().min(1, "vehicleModel is required"),
  vehicleColor: z.string().min(1, "vehicleColor is required"),
  vehiclePlate: z.string().min(1, "vehiclePlate is required"),
  status: z.enum(DRIVER_STATUSES).optional(),
  location: latLngSchema.optional(),
});
export type CreateDriverInput = z.infer<typeof createDriverSchema>;

export const patchDriverStatusSchema = z.object({
  status: z.enum(DRIVER_STATUSES, {
    error: `status must be one of: ${DRIVER_STATUSES.join(", ")}`,
  }),
});
export type PatchDriverStatusInput = z.infer<typeof patchDriverStatusSchema>;

export const patchDriverLocationSchema = latLngSchema;
export type PatchDriverLocationInput = z.infer<typeof patchDriverLocationSchema>;

// Bounds enforced on GET /drivers/nearby so a caller can't force Redis to scan/return an
// unreasonably large radius or result set. Chosen deliberately to reject with 400 rather than
// silently clamp — a caller asking for 500km should get a clear error, not a quietly-truncated
// 50km answer it might not notice.
export const NEARBY_DEFAULT_RADIUS_METERS = 5_000;
export const NEARBY_MAX_RADIUS_METERS = 50_000;
export const NEARBY_DEFAULT_LIMIT = 20;
export const NEARBY_MAX_LIMIT = 100;

export const nearbyQuerySchema = z.object({
  lat: z.coerce
    .number({ error: "lat is required and must be a number" })
    .min(-90, "lat must be between -90 and 90")
    .max(90, "lat must be between -90 and 90"),
  lng: z.coerce
    .number({ error: "lng is required and must be a number" })
    .min(-180, "lng must be between -180 and 180")
    .max(180, "lng must be between -180 and 180"),
  radius: z.coerce
    .number()
    .positive("radius must be a positive number of meters")
    .max(NEARBY_MAX_RADIUS_METERS, `radius must be <= ${NEARBY_MAX_RADIUS_METERS} meters`)
    .default(NEARBY_DEFAULT_RADIUS_METERS),
  limit: z.coerce
    .number()
    .int("limit must be an integer")
    .positive("limit must be a positive integer")
    .max(NEARBY_MAX_LIMIT, `limit must be <= ${NEARBY_MAX_LIMIT}`)
    .default(NEARBY_DEFAULT_LIMIT),
});
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;

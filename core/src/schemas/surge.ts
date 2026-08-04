import { z } from "zod";

// lat/lng are optional but must both be present or both be absent — GET /surge with neither
// lists every tracked zone; with both, it returns just the one zone covering that point.
export const surgeQuerySchema = z
  .object({
    lat: z.coerce
      .number({ error: "lat must be a number" })
      .min(-90, "lat must be between -90 and 90")
      .max(90, "lat must be between -90 and 90")
      .optional(),
    lng: z.coerce
      .number({ error: "lng must be a number" })
      .min(-180, "lng must be between -180 and 180")
      .max(180, "lng must be between -180 and 180")
      .optional(),
  })
  .refine((data) => (data.lat === undefined) === (data.lng === undefined), {
    message: "lat and lng must both be provided together, or both omitted",
  });
export type SurgeQuery = z.infer<typeof surgeQuerySchema>;

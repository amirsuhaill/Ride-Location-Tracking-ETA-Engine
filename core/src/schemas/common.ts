import { z } from "zod";

export const latLngSchema = z.object({
  lat: z
    .number({ error: "lat is required and must be a number" })
    .min(-90, "lat must be between -90 and 90")
    .max(90, "lat must be between -90 and 90"),
  lng: z
    .number({ error: "lng is required and must be a number" })
    .min(-180, "lng must be between -180 and 180")
    .max(180, "lng must be between -180 and 180"),
});
export type LatLng = z.infer<typeof latLngSchema>;

export const uuidParamSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

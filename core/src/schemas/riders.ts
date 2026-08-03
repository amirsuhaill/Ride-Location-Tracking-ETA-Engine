import { z } from "zod";

export const createRiderSchema = z.object({
  name: z.string().min(1, "name is required"),
});
export type CreateRiderInput = z.infer<typeof createRiderSchema>;

import { z } from "zod";

export const createFlagSchema = z.object({
  contentType: z.enum(["memory", "photo"]),
  contentId: z.string().uuid(),
  description: z.string().min(1),
});
export type CreateFlagInput = z.infer<typeof createFlagSchema>;

export const appealFlagSchema = z.object({
  description: z.string().min(1),
});
export type AppealFlagInput = z.infer<typeof appealFlagSchema>;

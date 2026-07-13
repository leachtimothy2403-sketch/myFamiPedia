import { z } from "zod";

export const searchQuerySchema = z.object({
  q: z.string().min(1),
  mode: z.enum(["keyword", "semantic"]).default("semantic"),
  person: z.string().uuid().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  mediaType: z.enum(["photo", "text", "voice"]).optional(),
  contributor: z.string().uuid().optional(),
});
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;

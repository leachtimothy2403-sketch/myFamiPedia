import { z } from "zod";

export const provenanceTypeSchema = z.enum(["voice", "photo", "text", "ai_generated"]);
export const reactionTypeSchema = z.enum(["touched_me", "i_remember_this_too"]);

export const createMemorySchema = z.object({
  content: z.string().min(1).nullable().optional(),
  mediaUrl: z.string().url().nullable().optional(),
  eventDate: z.string().date().nullable().optional(),
  provenanceType: provenanceTypeSchema,
  isPrivate: z.boolean().default(false),
  personIds: z.array(z.string().uuid()).default([]), // -> memory_persons
  photoIds: z.array(z.string().uuid()).default([]), // -> memory_photos
});
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;

export const reactToMemorySchema = z.object({
  reactionType: reactionTypeSchema,
});
export type ReactToMemoryInput = z.infer<typeof reactToMemorySchema>;

// DELETE /memories/:id has no body — eligibility is derived server-side
// (unlinked, unreacted, non-voice, non-posthumous). retract/restore likewise
// take no body; the id in the path plus the authenticated contributor is enough.

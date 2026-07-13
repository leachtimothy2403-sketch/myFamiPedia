import { z } from "zod";

// Two entry points collapse to one shape: triggeringPhotoId set = photo-triggered,
// unset + contact info = manual add. See docs/api_structure.md.
export const createInvitationSchema = z.object({
  personId: z.string().uuid(),
  triggeringPhotoId: z.string().uuid().nullable().optional(),
  inviteeEmail: z.string().email().nullable().optional(),
  inviteePhone: z.string().nullable().optional(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

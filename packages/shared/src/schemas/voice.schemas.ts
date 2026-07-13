import { z } from "zod";

// Moment 1: preview only, no consent recorded yet.
export const voicePreviewSchema = z.object({
  audioR2Key: z.string().min(1),
});
export type VoicePreviewInput = z.infer<typeof voicePreviewSchema>;

// Moments 2-3: consent decision + confirmation. consentedBy must equal the
// person's own id at the API layer — self-consent only, never admin-writable.
export const voiceConsentSchema = z.object({
  consented: z.boolean(),
});
export type VoiceConsentInput = z.infer<typeof voiceConsentSchema>;

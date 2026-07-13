export type VoiceTier = "instant" | "professional";
export type VoiceConsentStatus = "none" | "previewed" | "consented" | "paused" | "revoked";

export interface VoiceModel {
  id: string;
  personId: string;
  elevenlabsModelId: string | null;
  tier: VoiceTier | null;
  audioSecondsAccumulated: number;
  consentStatus: VoiceConsentStatus;
  consentDate: string | null;
  consentedBy: string | null; // normally === personId, self-consent only
  createdAt: string;
  updatedAt: string;
}

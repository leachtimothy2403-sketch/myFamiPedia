export type ProposedMemoryStatus = "pending" | "accepted" | "rejected";
export type QuestionFrequency = "never" | "few-days" | "weekly" | "daily";

export interface ProposedMemory {
  id: string;
  personId: string;
  photoId: string | null;
  status: ProposedMemoryStatus;
  createdAt: string;
}

export type HoldingSpaceMediaType = "photo" | "mention" | "voice";

export interface HoldingSpaceItem {
  id: string;
  personId: string;
  sourcePersonId: string;
  mediaType: HoldingSpaceMediaType;
  r2Key: string | null;
  rawMetadata: Record<string, unknown> | null;
  createdAt: string;
}

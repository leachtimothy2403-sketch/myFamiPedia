export type ProposedMemoryStatus = "pending" | "accepted" | "rejected";
// "few_days" (underscore) — matches the DB check constraint (migration
// 012_question_stream_columns.js) and collection.routes.ts's validation.
// See schemas/person.schemas.ts's questionFrequencySchema for the fuller
// note on why this drifted ("few-days") for a while without ever causing a
// real bug: neither app actually imports this type, each defines its own
// local copy with the correct value.
export type QuestionFrequency = "never" | "few_days" | "weekly" | "daily";

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

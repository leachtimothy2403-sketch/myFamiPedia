export type ProvenanceType = "voice" | "photo" | "text" | "ai_generated";
export type ReactionType = "touched_me" | "i_remember_this_too";

export interface Memory {
  id: string;
  familyGroupId: string;
  contributorId: string;
  content: string | null;
  mediaUrl: string | null;
  eventDate: string | null;
  provenanceType: ProvenanceType;
  provenanceLabel: string | null;
  isPrivate: boolean;
  disputed: boolean;
  retracted: boolean;
  retractedAt: string | null;
  isPosthumousContribution: boolean;
  createdAt: string;
}

export interface Reaction {
  id: string;
  memoryId: string;
  personId: string;
  reactionType: ReactionType;
  createdAt: string;
}

// Junction DTOs — thin, since these are mostly used to build request payloads
// (e.g. "link this memory to these person ids") rather than read as full rows.
export interface MemoryPersonLink {
  memoryId: string;
  personId: string;
}

export interface MemoryPhotoLink {
  memoryId: string;
  photoId: string;
}

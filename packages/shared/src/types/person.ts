export type PersonStatus = "active" | "invited_pending" | "declined_grace" | "opted_out" | "deceased";
export type PrivacyTier = 1 | 2 | 3;

export interface Person {
  id: string;
  familyGroupId: string;
  userId: string | null;
  name: string;
  birthDate: string | null;
  deathDate: string | null;
  status: PersonStatus;
  privacyTier: PrivacyTier | null;
  administratorPersonId: string | null;
  profileData: Record<string, unknown>;
  aiSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

// docs/data_model.md — parent_of / spouse_of / sibling_of / etc.
export type RelationshipType = "parent_of" | "spouse_of" | "sibling_of" | "child_of" | "other";

export interface Relationship {
  id: string;
  personAId: string;
  personBId: string;
  relationshipType: RelationshipType;
  createdAt: string;
}

import { z } from "zod";

export const relationshipTypeSchema = z.enum([
  "parent_of",
  "spouse_of",
  "sibling_of",
  "child_of",
  "other",
]);

export const privacyTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const updatePersonSchema = z.object({
  name: z.string().min(1).optional(),
  birthDate: z.string().date().nullable().optional(),
  deathDate: z.string().date().nullable().optional(),
  profileData: z.record(z.unknown()).optional(),
});
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;

export const createRelationshipSchema = z.object({
  personAId: z.string().uuid(),
  personBId: z.string().uuid(),
  relationshipType: relationshipTypeSchema,
});
export type CreateRelationshipInput = z.infer<typeof createRelationshipSchema>;

// "few_days" (underscore), not "few-days" — matches apps/api's DB check
// constraint (migration 012_question_stream_columns.js) and
// collection.routes.ts's validation, which is what actually governs the
// wire value. This schema was out of sync with the real API contract since
// at least 2026-07-17 (flagged in docs/handover_2026-07-17-settings-fixes.md
// and repeated in several later handover docs) but never fixed — turned out
// to be low-risk because nothing outside this file actually imports
// questionFrequencySchema or the QuestionFrequency type from
// packages/shared/src/types/collection.ts; both the web
// (useQuestionFrequency.ts) and mobile (collection/settings.tsx) apps define
// their own local QuestionFrequency type with the correct "few_days" value
// instead of importing this one, which is exactly why the mismatch never
// surfaced as a real bug — it just sat here unused and wrong.
export const questionFrequencySchema = z.enum(["never", "few_days", "weekly", "daily"]);

// Manual "add family member" flow — living branch (email/phone) vs deceased
// branch (birth/death dates, no contact info, no invitation created).
// See docs/data_model.md, "Adding a family member — living vs. deceased branch".
export const addFamilyMemberSchema = z.discriminatedUnion("isDeceased", [
  z.object({
    isDeceased: z.literal(false),
    name: z.string().min(1),
    relationshipType: relationshipTypeSchema,
    relatedToPersonId: z.string().uuid(),
    inviteeEmail: z.string().email().nullable().optional(),
    inviteePhone: z.string().nullable().optional(),
  }),
  z.object({
    isDeceased: z.literal(true),
    name: z.string().min(1),
    relationshipType: relationshipTypeSchema,
    relatedToPersonId: z.string().uuid(),
    birthDate: z.string().date().nullable().optional(),
    deathDate: z.string().date().nullable().optional(),
  }),
]);
export type AddFamilyMemberInput = z.infer<typeof addFamilyMemberSchema>;

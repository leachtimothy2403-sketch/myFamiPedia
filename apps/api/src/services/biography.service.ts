import type { Knex } from "knex";
import { updateBiographySectionSummary } from "./claude.service";

// Longest excerpt kept in a memory-derived asked_question_stems entry (see
// recordMemoryInBiography below) — long enough to be recognizable, short
// enough not to bloat the "already asked in this category" prompt text
// generateFollowUpQuestion shows the model.
const MEMORY_STEM_EXCERPT_LENGTH = 60;

// DB orchestration for interview_biography_sections (migration 026) —
// claude.service.ts stays a pure API-calling module, same convention as
// generateFollowUpQuestion; this file does the reads/writes and calls that
// module's pure functions, the way interviews.routes.ts already does for
// generateFollowUpQuestion itself.
//
// See migration 026's comment for the full "why": this replaces what used
// to be an ever-growing, unbounded raw list of every question ever asked
// (priorQuestionTexts) with one row per life-story category, continuously
// merged in place rather than appended to — bounded by how much there is to
// say about a category, not by how many questions have been asked.

export interface BiographySection {
  lifePhase: string;
  summary: string;
  askedQuestionStems: string[];
  questionCount: number;
}

interface BiographySectionRow {
  id: string;
  person_id: string;
  life_phase: string;
  summary: string;
  asked_question_stems: string[];
  question_count: number;
}

// Called once per transcribed answer that has a known category — see
// jobs/transcribeAnswer.ts, the only caller, which skips this entirely for
// open-ended answers with no questionId (migration 021) since those have no
// life_phase to file under. Upserts the one section this answer belongs to;
// every other category's row is untouched, which is the whole point — cost
// and prompt size stay flat as an interview gets longer, not linear.
export async function recordAnswerInBiography(
  trx: Knex.Transaction | Knex,
  params: { personId: string; personName: string; lifePhase: string; question: string; answer: string }
): Promise<void> {
  const existing: BiographySectionRow | undefined = await trx("interview_biography_sections")
    .where({ person_id: params.personId, life_phase: params.lifePhase })
    .first();

  const updatedSummary = await updateBiographySectionSummary({
    personName: params.personName,
    lifePhase: params.lifePhase,
    existingSummary: existing?.summary ?? "",
    question: params.question,
    answer: params.answer,
  });

  const existingStems = existing?.asked_question_stems ?? [];
  const newStems = existingStems.includes(params.question) ? existingStems : [...existingStems, params.question];

  if (existing) {
    await trx("interview_biography_sections").where({ id: existing.id }).update({
      summary: updatedSummary,
      asked_question_stems: newStems,
      question_count: existing.question_count + 1,
      updated_at: new Date(),
    });
  } else {
    await trx("interview_biography_sections").insert({
      person_id: params.personId,
      life_phase: params.lifePhase,
      summary: updatedSummary,
      asked_question_stems: newStems,
      question_count: 1,
    });
  }
}

// Companion to recordAnswerInBiography, for content that reaches the
// biography from outside the Q&A interview flow entirely: a memory shared
// directly, or a caption added later to a photo-sourced memory (both via
// memories.routes.ts — see memoryBiography.worker.ts, the only caller,
// which figures out the life_phase via claude.service.ts's
// classifyMemoryCategory first since a freeform memory has no question_id
// to trace a category back through the way an interview answer does).
//
// A memory has no real "question" behind it, so this can't just pass a
// fixed placeholder string through to recordAnswerInBiography's `question`
// param — asked_question_stems isn't only display text (the "already asked
// in this category" list generateFollowUpQuestion's prompt shows), its
// LENGTH is also what claude.service.ts's tallyCategoryCounts reads as the
// whole-interview category tally that drives category-pacing. A fixed
// placeholder would dedupe every memory in a category down to one stem
// (recordAnswerInBiography only appends a stem if it isn't already present)
// and silently undercount how much that category has actually covered.
// Using a short excerpt of the memory's own content keeps each one distinct.
export async function recordMemoryInBiography(
  trx: Knex.Transaction | Knex,
  params: { personId: string; personName: string; lifePhase: string; content: string }
): Promise<void> {
  const excerpt =
    params.content.length > MEMORY_STEM_EXCERPT_LENGTH
      ? `${params.content.slice(0, MEMORY_STEM_EXCERPT_LENGTH)}…`
      : params.content;
  const stem = `(memory shared: "${excerpt}")`;

  await recordAnswerInBiography(trx, {
    personId: params.personId,
    personName: params.personName,
    lifePhase: params.lifePhase,
    question: stem,
    answer: params.content,
  });
}

// Read side — generateFollowUpQuestion's biographySections input
// (interviews.routes.ts) and synthesizeBiography's sections input
// (interview-sessions/:id/complete) both just want every section this
// person has so far; ordering doesn't matter to either caller, so this
// stays unopinionated about it.
export async function getBiographySections(trx: Knex.Transaction | Knex, personId: string): Promise<BiographySection[]> {
  const rows: BiographySectionRow[] = await trx("interview_biography_sections").where({ person_id: personId });
  return rows.map((r) => ({
    lifePhase: r.life_phase,
    summary: r.summary,
    askedQuestionStems: r.asked_question_stems,
    questionCount: r.question_count,
  }));
}

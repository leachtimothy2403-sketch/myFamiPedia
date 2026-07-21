import type { Knex } from "knex";
import { updateBiographySectionSummary, rebuildBiographySectionSummary } from "./claude.service";

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
//
// memoryId (migration 028): every caller of this function already has, or
// just created, a `memories` row for this exact content (transcribeAnswer.ts,
// collection.routes.ts's question-prompt answer route, and
// recordMemoryInBiography below) — recorded here as a source row purely so a
// later retraction of that memory has something concrete to recompute this
// section FROM. See recomputeBiographySection below for the other half.
export async function recordAnswerInBiography(
  trx: Knex.Transaction | Knex,
  params: { personId: string; personName: string; lifePhase: string; question: string; answer: string; memoryId: string }
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

  await trx("interview_biography_sources").insert({
    person_id: params.personId,
    life_phase: params.lifePhase,
    memory_id: params.memoryId,
    stem: params.question,
    content: params.answer,
  });
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
  params: { personId: string; personName: string; lifePhase: string; content: string; memoryId: string }
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
    memoryId: params.memoryId,
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

// 2026-07-20 — the fix for a real, reported bug: retracting a Q&A answer (or
// any memory) that had already fed into a biography section left that
// content sitting in the summary forever, since recordAnswerInBiography only
// ever folds new content IN, never back out. There's no way to edit the
// merged prose to remove just one contribution's influence, so this rebuilds
// the section from scratch from whatever interview_biography_sources rows
// still have a live (non-retracted) memory behind them — called from
// memories.routes.ts's retract AND restore handlers (both directions: taking
// content away should shrink the section, giving it back should restore it),
// non-fatally, the same way every other biography-touching call site this
// week wraps its Claude call in a try/catch rather than letting a hiccup here
// undo the retraction/restore action that already succeeded.
//
// A memory_id of NULL is treated as "can't be retracted, always keep" —
// every current call site provides a real one, this only guards against a
// hypothetical future caller that doesn't.
export async function recomputeBiographySection(
  trx: Knex.Transaction | Knex,
  params: { personId: string; personName: string; lifePhase: string }
): Promise<void> {
  const existing: BiographySectionRow | undefined = await trx("interview_biography_sections")
    .where({ person_id: params.personId, life_phase: params.lifePhase })
    .first();
  // Nothing to recompute — this person/category never had a section (or it
  // was already cleaned up by an earlier recompute call).
  if (!existing) return;

  const surviving: { stem: string; content: string }[] = await trx("interview_biography_sources as s")
    .leftJoin("memories as m", "m.id", "s.memory_id")
    .where({ "s.person_id": params.personId, "s.life_phase": params.lifePhase })
    .andWhere((qb) => qb.whereNull("s.memory_id").orWhere("m.retracted", false))
    .orderBy("s.created_at", "asc")
    .select("s.stem", "s.content");

  if (surviving.length === 0) {
    // Every source this category ever had has since been retracted — delete
    // the section rather than leave stale prose with nothing behind it.
    await trx("interview_biography_sections").where({ id: existing.id }).delete();
    await trx("interview_biography_sources").where({ person_id: params.personId, life_phase: params.lifePhase }).delete();
    return;
  }

  const rebuiltSummary = await rebuildBiographySectionSummary({
    personName: params.personName,
    lifePhase: params.lifePhase,
    answers: surviving.map((s) => s.content),
  });

  await trx("interview_biography_sections").where({ id: existing.id }).update({
    summary: rebuiltSummary,
    asked_question_stems: surviving.map((s) => s.stem),
    question_count: surviving.length,
    updated_at: new Date(),
  });
}

// Companion lookup for the retract/restore route handlers: given a memory
// that's just been retracted or restored, which (person, life_phase)
// sections did it ever contribute to? Usually one, but a memory tagged to
// multiple people is filed under each of them separately (see
// memoryBiography.worker.ts), so this can return more than one row.
export async function getBiographySectionsForMemory(
  trx: Knex.Transaction | Knex,
  memoryId: string
): Promise<{ personId: string; personName: string; lifePhase: string }[]> {
  const rows: { person_id: string; life_phase: string; name: string }[] = await trx("interview_biography_sources as s")
    .join("persons as p", "p.id", "s.person_id")
    .where({ "s.memory_id": memoryId })
    .distinct("s.person_id", "s.life_phase", "p.name");
  return rows.map((r) => ({ personId: r.person_id, personName: r.name, lifePhase: r.life_phase }));
}

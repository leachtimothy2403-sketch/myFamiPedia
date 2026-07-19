import type { Knex } from "knex";
import { updateBiographySectionSummary } from "./claude.service";

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

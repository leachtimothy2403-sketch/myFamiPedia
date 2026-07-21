import type { Knex } from "knex";
import { generateClarifyingQuestion } from "./claude.service";

// Bounds on the "Tell your story" clarifying follow-up (2026-07-21/22,
// migration 029) — deliberately conservative on top of
// generateClarifyingQuestion's own conservative prompt, because even a
// well-judged clarifying question gets old fast if it fires on every single
// answer, and this app's audience skews toward older adults who a rapid-fire
// "wait, what did you mean by X" pattern would frustrate rather than help.
//
// SESSION_CLARIFICATION_CAP: a soft ceiling on how many clarifications one
// session ever offers, regardless of how many answers get given — same
// "bounded, not unlimited" principle as the running-biography work earlier
// this week (interview_biography_sections replacing an ever-growing
// askedList). A long interview shouldn't start to feel like it's constantly
// double-checking things.
export const SESSION_CLARIFICATION_CAP = 4;

// SKIP_STREAK_BACKOFF_THRESHOLD: skipping this many clarifications in a row
// is treated as a real "I don't want this right now" signal, not something
// to keep pushing through — clarifications stop being offered for the rest
// of the session once hit. Resets to 0 the moment one gets answered instead
// of skipped.
export const SKIP_STREAK_BACKOFF_THRESHOLD = 2;

export interface OfferClarificationParams {
  sessionId: string;
  answerId: string;
  // True when the answer being finalized is itself someone's response to a
  // previously-offered clarifying question — never offer a further
  // clarification on top of a clarification. No chaining.
  isClarificationAnswer: boolean;
  personName: string;
  question: string | null;
  answer: string;
}

// Called once per answer, right after its transcript is known (both the
// synchronous and async-worker transcription paths — see
// transcribeAnswer.ts's finalizeTranscribedAnswer, the only caller) and once
// per text answer submitted directly (interviews.routes.ts's /answers
// handler, text branch). Returns the clarifying question text if one was
// generated and offered (also persisted onto the answer row here, so it's
// readable later via GET /interview-sessions/:id regardless of which path
// triggered it), or null if nothing was offered — either because
// generateClarifyingQuestion said NONE, or because a cap/backoff already
// ruled it out before spending a Claude call on the question at all.
export async function maybeOfferClarification(
  trx: Knex.Transaction | Knex,
  params: OfferClarificationParams
): Promise<string | null> {
  if (params.isClarificationAnswer) return null;

  const session = await trx("interview_sessions").where({ id: params.sessionId }).first();
  if (!session) return null;
  if (session.clarifications_offered_count >= SESSION_CLARIFICATION_CAP) return null;
  if (session.clarifications_skip_streak >= SKIP_STREAK_BACKOFF_THRESHOLD) return null;

  const question = await generateClarifyingQuestion({
    personName: params.personName,
    question: params.question,
    answer: params.answer,
  });
  if (!question) return null;

  await trx("interview_sessions")
    .where({ id: params.sessionId })
    .update({ clarifications_offered_count: session.clarifications_offered_count + 1 });
  await trx("interview_answers").where({ id: params.answerId }).update({ clarifying_question: question });
  return question;
}

// POST /interview-sessions/:id/answers/:answerId/skip-clarification's only
// job — the skip button has to be at least as easy to tap as answering, so
// this is deliberately a single, cheap counter bump, nothing else.
export async function recordClarificationSkipped(trx: Knex.Transaction | Knex, sessionId: string): Promise<void> {
  await trx("interview_sessions").where({ id: sessionId }).increment("clarifications_skip_streak", 1);
}

// Called whenever a clarification actually gets answered (interviews.routes.ts's
// /answers handler, when clarifiesAnswerId is present) — a real answer resets
// the streak, since the backoff is about consecutive skips specifically, not
// a lifetime tally.
export async function recordClarificationAnswered(trx: Knex.Transaction | Knex, sessionId: string): Promise<void> {
  await trx("interview_sessions").where({ id: sessionId }).update({ clarifications_skip_streak: 0 });
}

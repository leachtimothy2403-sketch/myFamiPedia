// Running, per-category biography — the answer to a cost question, not just
// a feature request (docs/handover_2026-07-19-qa-persona-eval.md). Once a
// real dollar cost was put on generateFollowUpQuestion's prompt (~1.4 cents
// at question 90, and climbing every question after that, no ceiling), the
// obvious next question was: does the interviewer prompt actually need the
// full, ever-growing list of every question ever asked (priorQuestionTexts)
// to do its job? Mostly no — tallyCategoryCounts only ever used each
// question's life_phase, never its text, and the category-balance prompt
// text was already computed from that tally in code, not derived by the
// model reading the raw list. The raw list's only real job was catching
// near-duplicate questions and reused anecdotes — something a compact,
// continuously-merged-in-place summary per category can do at least as
// well, without ever growing past what's actually distinct to say about
// that one category.
//
// One row per (person, life_phase). asked_question_stems is a native
// Postgres array (text[]), same choice interview_questions.based_on_answer_ids
// (migration 022) already made and already proven to round-trip cleanly
// through knex/pg in this codebase — deliberately not jsonb, to sidestep
// node-postgres's well-known array-vs-jsonb serialization gotcha rather than
// having to work around it.
//
// Second-order use, not just a cost fix: these compact per-category
// summaries are exactly what synthesizeBiography (claude.service.ts) needs
// to assemble persons.ai_summary — the "who they were" paragraph
// GET /persons/:id/summary has been reading since migration 003 but nothing
// has ever written to (persons.routes.ts's own comment called it "still a
// stub"). Tim's second half of the same question: this is also the family's
// legacy document if the interview subject passes away, built cheaply from
// these short summaries instead of needing to re-read a whole raw
// transcript at that point.
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE interview_biography_sections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      life_phase text NOT NULL,
      summary text NOT NULL DEFAULT '',
      asked_question_stems text[] NOT NULL DEFAULT '{}',
      question_count int NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (person_id, life_phase)
    );
    CREATE INDEX idx_interview_biography_sections_person ON interview_biography_sections(person_id);
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_interview_biography_sections_person;
    DROP TABLE IF EXISTS interview_biography_sections CASCADE;
  `);
};

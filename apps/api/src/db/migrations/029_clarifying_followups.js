// Clarifying follow-ups (2026-07-21, discussed and designed with Tim over
// several messages before this was built — see
// docs/handover_2026-07-22-overnight-clarifying-followups.md for the full
// writeup). Right after someone answers in the "Tell your story" flow, a
// cheap Claude check (claude.service.ts's generateClarifyingQuestion) looks
// for a specific, nameable fact the answer left out (a name, a place, a
// date) worth asking about — pairs with the biography-fabrication fix from
// earlier this week: better to ask the storyteller for the missing detail
// while they're right there than let the summarizer guess or leave it vague.
//
// clarifies_answer_id: self-referencing, nullable. Marks an answer row as
// answering a clarifying question rather than a regular interview question —
// used to make sure a clarification's own answer never itself gets offered a
// further clarification (no chaining). ON DELETE SET NULL rather than
// CASCADE: if the original answer is ever removed, the clarification content
// itself is still real, standalone content worth keeping.
//
// clarifying_question: the generated question text itself, persisted on the
// ORIGINAL answer it was generated for (not the clarification's own row) —
// this is what the client reads to know a clarification is being offered,
// via either the synchronous POST /interview-sessions/:id/answers response
// or a later GET /interview-sessions/:id poll, covering both the
// synchronous (ElevenLabs+R2 configured) and async-worker transcription
// paths uniformly.
//
// clarifications_offered_count / clarifications_skip_streak on
// interview_sessions: the session-wide soft cap (stop offering after
// SESSION_CLARIFICATION_CAP, clarification.service.ts) and the skip-streak
// backoff (stop offering entirely once skipped SKIP_STREAK_BACKOFF_THRESHOLD
// times in a row — a real "I don't want this right now" signal, not
// something to keep pushing through).
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE interview_answers ADD COLUMN clarifies_answer_id uuid REFERENCES interview_answers(id) ON DELETE SET NULL;
    ALTER TABLE interview_answers ADD COLUMN clarifying_question text;
    ALTER TABLE interview_sessions ADD COLUMN clarifications_offered_count int NOT NULL DEFAULT 0;
    ALTER TABLE interview_sessions ADD COLUMN clarifications_skip_streak int NOT NULL DEFAULT 0;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE interview_sessions DROP COLUMN IF EXISTS clarifications_skip_streak;
    ALTER TABLE interview_sessions DROP COLUMN IF EXISTS clarifications_offered_count;
    ALTER TABLE interview_answers DROP COLUMN IF EXISTS clarifying_question;
    ALTER TABLE interview_answers DROP COLUMN IF EXISTS clarifies_answer_id;
  `);
};

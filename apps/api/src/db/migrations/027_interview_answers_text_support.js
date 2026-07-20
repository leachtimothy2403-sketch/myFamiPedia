// interview_answers.audio_r2_key has been NOT NULL since migration 008 —
// correct as long as the only way to answer a curated/generated question was
// the structured voice interview screen (POST /interview-sessions/:id/answers).
// docs/section2_pipeline.md section 4's question-stream nudge feature answers
// the exact same interview_questions bank but explicitly supports a plain
// text answer too ("voice answers go through Q_TRANS; both land in
// memories") — collection.routes.ts's POST /question-prompt/:id/answer,
// previously a stub, reuses interview_answers/interview_sessions as the
// single source of truth for "has this question been answered" (the sibling
// GET /persons/:id/question-prompt endpoint already reads that, not
// `memories`) rather than inventing a second, parallel tracking mechanism —
// which means a text-only answer needs a row here too, with no audio at all.
//
// transcript already exists and is nullable — a text answer sets it directly
// at insert time (it IS its own transcript, no transcription step needed);
// a voice answer still leaves it null until Q_TRANS fills it in, unchanged.
// The CHECK constraint keeps the one invariant that actually matters: a row
// must have SOMETHING (audio to eventually transcribe, or a transcript
// already in hand) — it should never be possible to insert a row with
// neither.
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE interview_answers ALTER COLUMN audio_r2_key DROP NOT NULL;
    ALTER TABLE interview_answers ADD CONSTRAINT interview_answers_audio_or_transcript_check
      CHECK (audio_r2_key IS NOT NULL OR transcript IS NOT NULL);
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE interview_answers DROP CONSTRAINT IF EXISTS interview_answers_audio_or_transcript_check;
    ALTER TABLE interview_answers ALTER COLUMN audio_r2_key SET NOT NULL;
  `);
};

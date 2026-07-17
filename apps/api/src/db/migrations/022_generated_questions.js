// Adaptive Q&A (see docs/section2_pipeline.md section 4's "Claude-generated,
// personalized against existing memories" pattern — reused here for the
// live in-session flow, not just the async Q_CRON push). The curated bank
// (migration 008) is shared across everyone and never runs out functionally,
// but the product now wants sessions to work through it in sort_order first,
// then switch to person-specific follow-ups once it's exhausted.
//
// person_id is nullable specifically so the existing shared bank rows keep
// working unchanged (person_id IS NULL, source='curated'); generated rows
// are scoped to one person and never shown to anyone else. Storing generated
// questions as real interview_questions rows (rather than a separate table)
// means interview_answers.question_id keeps pointing at one place regardless
// of where the question came from.
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE interview_questions
      ADD COLUMN person_id uuid REFERENCES persons(id),
      ADD COLUMN source text NOT NULL DEFAULT 'curated' CHECK (source IN ('curated', 'generated')),
      ADD COLUMN based_on_answer_ids uuid[],
      ADD COLUMN created_at timestamptz DEFAULT now();

    -- A generated question must belong to someone; a curated one must not.
    ALTER TABLE interview_questions
      ADD CONSTRAINT interview_questions_person_source_check
      CHECK (
        (source = 'curated' AND person_id IS NULL) OR
        (source = 'generated' AND person_id IS NOT NULL)
      );

    CREATE INDEX interview_questions_person_id_idx ON interview_questions (person_id) WHERE person_id IS NOT NULL;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS interview_questions_person_id_idx;
    ALTER TABLE interview_questions DROP CONSTRAINT IF EXISTS interview_questions_person_source_check;
    ALTER TABLE interview_questions
      DROP COLUMN IF EXISTS created_at,
      DROP COLUMN IF EXISTS based_on_answer_ids,
      DROP COLUMN IF EXISTS source,
      DROP COLUMN IF EXISTS person_id;
  `);
};

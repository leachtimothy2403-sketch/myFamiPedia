// docs/section2_pipeline.md section 4 (question stream) and section 2/3
// (review cadence, manual-tier nudge) reference persons.question_frequency
// and three scheduling timestamps that were never actually added to the
// schema in migration 003 — a gap between the documented cron behavior and
// the data model as built. Adding them now while implementing the routes
// that need them (GET/PATCH /persons/:id/question-frequency, the Q_CRON
// jobs described in the doc).
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons
      ADD COLUMN question_frequency text NOT NULL DEFAULT 'weekly'
        CHECK (question_frequency IN ('never', 'few_days', 'weekly', 'daily')),
      ADD COLUMN last_prompt_sent_at timestamptz,
      ADD COLUMN last_manual_add_at timestamptz,
      ADD COLUMN last_review_notification_at timestamptz;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons
      DROP COLUMN IF EXISTS last_review_notification_at,
      DROP COLUMN IF EXISTS last_manual_add_at,
      DROP COLUMN IF EXISTS last_prompt_sent_at,
      DROP COLUMN IF EXISTS question_frequency;
  `);
};

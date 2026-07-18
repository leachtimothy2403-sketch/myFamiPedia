// interview_answers.question_id was NOT NULL, but the product supports
// open-ended answers with no specific question attached (mobile's "Share a
// memory / talk about your life" and "Start with a picture" starting
// points, per app/interview/[personId]/new.tsx) — those sessions have
// nothing to put in this column. Made nullable so those paths can actually
// save an answer instead of being blocked by this FK.
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE interview_answers ALTER COLUMN question_id DROP NOT NULL;`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE interview_answers ALTER COLUMN question_id SET NOT NULL;`);
};

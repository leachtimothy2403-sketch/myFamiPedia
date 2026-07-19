// Fresh dev/test bootstrap only — del()+insert() from scratch, so this is
// NOT safe to rerun once real interview_answers exist against these rows
// (interview_answers.question_id has no ON DELETE CASCADE; Postgres will
// reject the delete rather than corrupt anything, but that also means this
// script simply can't repopulate an already-used real database). For that
// path, see migrations/023_expand_curated_question_bank.js, which adds the
// same expanded set additively without touching the original rows.
//
// Question data itself lives in ../curatedQuestions.js, shared with that
// migration so the two can't drift apart. See that file's header for the
// full rationale behind the 15 -> 45 expansion, and for SENSORY_AND_SPECIFICS
// (45 -> 48, migrations/024_add_sensory_and_specifics_questions.js is the
// additive path for an already-seeded real database).
const { ORIGINAL_FIFTEEN, EXPANSION, SENSORY_AND_SPECIFICS } = require("../curatedQuestions");

exports.seed = async function (knex) {
  await knex("interview_questions").del();
  const rows = [...ORIGINAL_FIFTEEN, ...EXPANSION, ...SENSORY_AND_SPECIFICS];
  await knex("interview_questions").insert(
    rows.map(([life_phase, text], i) => ({ life_phase, text, sort_order: i + 1 }))
  );
};

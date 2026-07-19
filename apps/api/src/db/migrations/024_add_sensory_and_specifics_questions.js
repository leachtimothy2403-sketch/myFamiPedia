const { SENSORY_AND_SPECIFICS } = require("../curatedQuestions");

// 2026-07-19, later the same day as migration 023 — additive path for a real,
// already-seeded database, same reasoning as 023: del()+insert() (the seed
// script) can't safely rerun once real interview_answers exist against
// already-seeded curated questions, so new curated questions for an
// in-production bank have to arrive via an additive migration instead.
//
// Prompted by the persona eval's grading pass on a full 90-question run
// (docs/handover_2026-07-19-qa-persona-eval.md's "second-order fix" section):
// a handful of concrete, easy-to-ask facts (a childhood pet story, named
// specific likes/dislikes, a sensory-triggered memory) never came up because
// no curated question in any of the eighteen categories ever invited them —
// not a follow-up-quality problem, a structural gap in the question bank
// itself, the same category of fix migration 023 was for.
//
// Safe to run more than once: the insert step skips any question whose text
// already exists, same idempotency pattern as 023.
//
// Deliberately a no-op if the curated bank was never seeded at all — same
// reasoning as 023's guard: a brand new environment (including every
// automated test file, which runs migrate:latest but never the seed script)
// gets these three questions directly from the updated seed script once it
// seeds, so there's nothing here for a fresh environment to add yet, and
// every test file with its own small, deliberately-scoped interview_questions
// setup would otherwise find 3 uninvited rows already there before its own
// setup ran.
exports.up = async function (knex) {
  const anyCuratedPresent = await knex("interview_questions").where({ source: "curated" }).first();
  if (!anyCuratedPresent) return;

  const existingTexts = new Set(
    (await knex("interview_questions").where({ source: "curated" }).select("text")).map((r) => r.text)
  );
  const newRows = SENSORY_AND_SPECIFICS.filter(([, text]) => !existingTexts.has(text));
  if (newRows.length === 0) return; // already applied

  const maxSortOrderRow = await knex("interview_questions").where({ source: "curated" }).max("sort_order as max").first();
  const startAt = Number(maxSortOrderRow?.max ?? 0) + 1;
  await knex("interview_questions").insert(
    newRows.map(([life_phase, text], i) => ({ life_phase, text, sort_order: startAt + i, source: "curated" }))
  );
};

exports.down = async function (knex) {
  const texts = SENSORY_AND_SPECIFICS.map(([, text]) => text);
  await knex("interview_questions").where({ source: "curated" }).whereIn("text", texts).del();
};

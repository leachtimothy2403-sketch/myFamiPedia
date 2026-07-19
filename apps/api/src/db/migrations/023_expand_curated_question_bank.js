const { ORIGINAL_FIFTEEN, EXPANSION } = require("../curatedQuestions");

// 2026-07-19 — additive migration for a REAL, already-seeded database
// (e.g. Tim's own dev DB, or any environment with genuine interview_answers
// history already tied to the original 15 curated questions). The seed
// script (seeds/001_interview_questions.js) does del()+insert() from
// scratch, which is fine for a fresh test/dev environment but cannot be
// rerun once real answers exist — interview_answers.question_id has no
// ON DELETE CASCADE, so Postgres correctly refuses to delete a row real
// history depends on rather than silently losing it, but that also means
// the seed script is simply the wrong tool for expanding an
// already-populated bank. This migration is the right one: it never
// deletes anything, only re-tags ORIGINAL_FIFTEEN's life_phase onto the new
// eighteen-category taxonomy (matched by exact text, ids/rows themselves
// untouched) and inserts EXPANSION as brand-new rows. Both come from
// ../curatedQuestions.js, the single shared source of truth with the seed
// script, so the two can't drift apart.
//
// Safe to run more than once: the life_phase re-tag is idempotent (always
// sets the same value), and the insert step skips any EXPANSION question
// whose text already exists.
//
// Deliberately a no-op if the original 15 were never seeded at all (a brand
// new environment — including every automated test file, which runs
// migrate:latest but never the seed script). Without this guard, every
// fresh migrate would insert the 30 EXPANSION rows into an otherwise-empty
// interview_questions table, which is wrong for two reasons: a genuinely
// new environment gets everything it needs directly from the updated seed
// script (seeds/001_interview_questions.js, now built from the same shared
// data) once it seeds, so there's nothing here for this migration to add
// yet; and every test file that seeds its own small, deliberately-scoped
// interview_questions rows (e.g. interviews.test.ts's "lists the question
// bank" test) would otherwise find 30 uninvited rows already there before
// its own setup ever runs.
exports.up = async function (knex) {
  const anyOriginalPresent = await knex("interview_questions").where({ source: "curated" }).first();
  if (!anyOriginalPresent) return;

  for (const [newLifePhase, text] of ORIGINAL_FIFTEEN) {
    await knex("interview_questions").where({ text, source: "curated" }).update({ life_phase: newLifePhase });
  }

  const existingTexts = new Set(
    (await knex("interview_questions").where({ source: "curated" }).select("text")).map((r) => r.text)
  );
  const newRows = EXPANSION.filter(([, text]) => !existingTexts.has(text));
  if (newRows.length === 0) return; // already applied

  const maxSortOrderRow = await knex("interview_questions").where({ source: "curated" }).max("sort_order as max").first();
  const startAt = Number(maxSortOrderRow?.max ?? 0) + 1;
  await knex("interview_questions").insert(
    newRows.map(([life_phase, text], i) => ({ life_phase, text, sort_order: startAt + i, source: "curated" }))
  );
};

exports.down = async function (knex) {
  const expansionTexts = EXPANSION.map(([, text]) => text);
  await knex("interview_questions").where({ source: "curated" }).whereIn("text", expansionTexts).del();

  // Best-effort revert of the original 15's life_phase to their pre-2026-07-19 names.
  const priorTags = {
    "What is your earliest memory?": "childhood",
    "What did your street or neighborhood look like growing up?": "childhood",
    "Who was your best friend as a child, and what did you do together?": "childhood",
    "What was your favorite subject in school, and why?": "education",
    "Did you have a teacher who changed how you saw the world?": "education",
    "What was your first job, and what did it teach you?": "work",
    "What work are you most proud of?": "work",
    "How did you meet your spouse or partner?": "relationships",
    "What's a piece of advice about love you'd want your grandchildren to have?": "relationships",
    "What's a family tradition you hope continues after you?": "family",
    "What was it like when your first child was born?": "family",
    "What belief has guided you most through hard times?": "values",
    "What does a good life mean to you?": "values",
    "What do you hope people remember about you?": "legacy",
    "If you could tell your younger self one thing, what would it be?": "legacy",
  };
  for (const [text, life_phase] of Object.entries(priorTags)) {
    await knex("interview_questions").where({ text, source: "curated" }).update({ life_phase });
  }
};

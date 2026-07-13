// Starter set from docs/voice_pipeline.md's "50-100 curated life-story questions" —
// this is a representative sample across all seven life phases, not the full bank.
// Question quality is called out in the product doc as the most important investment
// in Section 3 — expand this list deliberately, don't just pad it.
exports.seed = async function (knex) {
  await knex("interview_questions").del();
  const rows = [
    ["childhood", "What is your earliest memory?"],
    ["childhood", "What did your street or neighborhood look like growing up?"],
    ["childhood", "Who was your best friend as a child, and what did you do together?"],
    ["education", "What was your favorite subject in school, and why?"],
    ["education", "Did you have a teacher who changed how you saw the world?"],
    ["work", "What was your first job, and what did it teach you?"],
    ["work", "What work are you most proud of?"],
    ["relationships", "How did you meet your spouse or partner?"],
    ["relationships", "What's a piece of advice about love you'd want your grandchildren to have?"],
    ["family", "What's a family tradition you hope continues after you?"],
    ["family", "What was it like when your first child was born?"],
    ["values", "What belief has guided you most through hard times?"],
    ["values", "What does a good life mean to you?"],
    ["legacy", "What do you hope people remember about you?"],
    ["legacy", "If you could tell your younger self one thing, what would it be?"],
  ];
  await knex("interview_questions").insert(
    rows.map(([life_phase, text], i) => ({ life_phase, text, sort_order: i + 1 }))
  );
};

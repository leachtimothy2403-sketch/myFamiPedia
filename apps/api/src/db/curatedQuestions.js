// Shared source of truth for the curated life-story question bank — imported
// by both seeds/001_interview_questions.js (fresh dev/test environments,
// del()+insert() from scratch) and migrations/023_expand_curated_question_bank.js
// (the additive path for an already-seeded real environment, where del() is
// unsafe — interview_answers.question_id has no ON DELETE CASCADE, so
// deleting a curated question with real answered history against it would
// fail loudly rather than corrupt anything, but it also means the seed
// script simply cannot be rerun once real answers exist). One definition
// here means the two paths can't drift apart.
//
// 2026-07-19 — expanded from the original 15 (seven categories) to 45 across
// eighteen. Designed around "what are the key things you'd need to know to
// get a grasp on someone's whole life," not padding — every new
// category/question either fills a structural gap the original seven left
// (nothing ever asked about siblings, romantic life before a spouse,
// financial hardship, or private passions) or one the persona eval
// (docs/handover_2026-07-19-qa-persona-eval.md) empirically caught going
// unasked across two real interview runs (Robert Chen, the Doreen
// estrangement — both categorically unreachable by the original bank).
//
// Three categories — partnership, parenthood, and romance — deliberately
// open with a screening-style question rather than presupposing marriage or
// children happened at all (Tim's explicit correction: don't assume a life
// path, ask first, the same way the original bank's "spouse or partner"
// phrasing already avoided presupposing marriage specifically over any
// long-term partnership).
//
// sort_order is stable and meaningful. ORIGINAL_FIFTEEN's ids and text are
// UNTOUCHED by the migration — only life_phase gets re-tagged onto the new
// taxonomy, since real answered history may already reference these rows by
// id. Everything in EXPANSION is new as of this date, sort_order 16 on.
//
// 2026-07-19, later the same day — three more added (SENSORY_AND_SPECIFICS
// below, sort_order 46-48) after the persona eval's grading pass on a full
// 90-question run flagged real, concrete, easy-to-ask facts that never came
// up because no curated question ever invited them: a rescued-stray-cat
// childhood story, named specific likes/dislikes, and a sensory
// smell/taste/sound memory. Not persona-specific padding — asking about a
// childhood pet/animal and a sensory-triggered memory are standard oral-
// history interview techniques for surfacing concrete, colorful detail a
// purely thematic question ("what belief guided you") tends to skip past.
// Deliberately NOT trying to fix the eval's other two callouts (Kessler's
// shoplifting-spotting skill, the switchboard job, each only mentioned once)
// with a curated question — those are "go deeper on one thing already
// mentioned" requests, which is exactly the drill-into-one-memory pattern
// docs/handover_2026-07-17-adaptive-qa-round2.md's "Tour de France" fixation
// bug taught this system to avoid; see claude.service.ts's docstring.
const ORIGINAL_FIFTEEN = [
  // Original life_phase values in comments — see the migration for the
  // re-tagging mapping onto the categories below.
  ["childhood", "What is your earliest memory?"], // was: childhood
  ["childhood", "What did your street or neighborhood look like growing up?"], // was: childhood
  ["childhood", "Who was your best friend as a child, and what did you do together?"], // was: childhood
  ["education", "What was your favorite subject in school, and why?"], // was: education
  ["education", "Did you have a teacher who changed how you saw the world?"], // was: education
  ["work", "What was your first job, and what did it teach you?"], // was: work
  ["work", "What work are you most proud of?"], // was: work
  ["partnership", "How did you meet your spouse or partner?"], // was: relationships
  ["partnership", "What's a piece of advice about love you'd want your grandchildren to have?"], // was: relationships
  ["legacy", "What's a family tradition you hope continues after you?"], // was: family
  ["parenthood", "What was it like when your first child was born?"], // was: family
  ["values", "What belief has guided you most through hard times?"], // was: values
  ["values", "What does a good life mean to you?"], // was: values
  ["legacy", "What do you hope people remember about you?"], // was: legacy
  ["legacy", "If you could tell your younger self one thing, what would it be?"], // was: legacy
];

const EXPANSION = [
  ["origins", "Where were you born, and what do you know about the circumstances you were born into?"],
  ["origins", "What do you know about your parents' or grandparents' lives before you came along?"],
  ["childhood", "What was it like growing up with, or without, brothers and sisters?"],
  ["education", "What did you dream of becoming when you were young, and where did that dream come from?"],
  ["coming_of_age", "What do you remember about the first time you truly felt like your own person, out from under your parents' roof?"],
  ["coming_of_age", "What was going on in the wider world as you were coming of age, and how did it touch your own life?"],
  ["romance", "Looking back at your early dating life, is there someone who stands out — whether or not it lasted?"],
  ["romance", "What did dating or courtship teach you about yourself?"],
  ["partnership", "Did you marry, or was there someone you spent a long portion of your life with as a partner?"],
  ["parenthood", "Did you have children, or did children play an important role in your life in another way — nieces, nephews, godchildren, students, someone you helped raise?"],
  ["parenthood", "How did having children — your own or others' — change the way you saw your own parents?"],
  ["parenthood", "What's something different about each child in your life that you've loved discovering?"],
  ["siblings_family", "What's your relationship like with your siblings today, and how has it changed over the years?"],
  ["siblings_family", "Is there a relationship in your family that never quite healed the way you wish it had?"],
  ["friendship", "Who's a friend who's mattered to you at a completely different stage of life than childhood?"],
  ["friendship", "What do you think makes a friendship last decades instead of fading?"],
  ["work", "Was there a job or opportunity you turned down or didn't get, and how did that change things?"],
  ["work", "What ambition did you have that life didn't end up making room for?"],
  ["money", "Was there a stretch of your life when money was especially tight, and how did you get through it?"],
  ["money", "How did the financial circumstances you grew up in shape choices you made later?"],
  ["health_hardship", "What's the hardest loss you've had to carry, and what helped you carry it?"],
  ["health_hardship", "Has your health, or the health of someone you loved, ever changed the direction of your life?"],
  ["historical_context", "What historical event, big or small in the history books, do you remember living through most vividly?"],
  ["community_faith", "What role has faith, or a sense of something bigger than yourself, played in your life?"],
  ["community_faith", "Where have you felt most like you belonged — a place, a group, a community?"],
  ["passions", "What's something you've loved doing purely for yourself, that had nothing to do with work or family?"],
  ["passions", "Is there a talent, interest, or chapter of your life that might surprise the people who know you now?"],
  ["turning_points", "Looking back, what was a decision or fork in the road that changed the whole direction of your life?"],
  ["turning_points", "Is there a moment you wish you could go back and do differently?"],
  ["legacy", "What do you feel most grateful for when you look back on your life as a whole?"],
];

// 2026-07-19, later the same day — see the dated comment above ORIGINAL_FIFTEEN
// for why these exist. sort_order 46-48, additive via migration 024 the same
// way EXPANSION was added via migration 023.
const SENSORY_AND_SPECIFICS = [
  ["childhood", "Was there a pet or animal that mattered to you at some point in your life — is there a story behind it?"],
  ["passions", "Is there a specific smell, taste, or sound that instantly takes you back to another time in your life?"],
  ["passions", "Are there things you love or can't stand — foods, sounds, situations — that say something about who you are?"],
];

// The full set of valid life-story categories a curated OR generated
// question can belong to — shared with claude.service.ts's follow-up
// generator so it always picks from this same list, and so
// interviews.routes.ts can validate/fall back if a generated response ever
// names something outside it.
const INTERVIEW_CATEGORIES = [
  "origins",
  "childhood",
  "education",
  "coming_of_age",
  "romance",
  "partnership",
  "parenthood",
  "siblings_family",
  "friendship",
  "work",
  "money",
  "health_hardship",
  "historical_context",
  "community_faith",
  "passions",
  "values",
  "turning_points",
  "legacy",
];

module.exports = { ORIGINAL_FIFTEEN, EXPANSION, SENSORY_AND_SPECIFICS, INTERVIEW_CATEGORIES };

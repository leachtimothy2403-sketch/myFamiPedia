# myFamiPedia — Adaptive Q&A persona eval (2026-07-19)

A manual eval tool for the adaptive Q&A feature (`docs/handover_2026-07-17-adaptive-qa.md`, `docs/handover_2026-07-17-adaptive-qa-round2.md`), built because Tim wanted a repeatable way to test question quality without waiting on a real interview subject.

## What it is

`apps/api/scripts/personaQaEval/` — not a vitest test (deliberately not named `*.test.ts`, so `pnpm test`/CI never picks it up). It:

1. Boots the same in-memory pglite Postgres the real test suite uses and seeds the curated question bank (45 questions across 18 categories as of 2026-07-19 — see below).
2. Registers a throwaway account and works through the REAL `GET /interview-questions/next` endpoint exactly like the mobile app does — curated bank first, then Claude-generated follow-ups once exhausted.
3. Each question is answered by a second Claude call playing a fully fictional persona (`persona.ts`) — Margaret "Peggy" Alsop, a detailed 70-something life story spanning every curated life phase (childhood, education, work, relationships, family, values, legacy) plus hobbies/likes/dislikes. The persona is instructed to answer like a real interview subject: warm and specific on topics she's open about, brief and deflecting on a handful of facts she'd only reveal if asked well (a broken first engagement, dropping out of college, a secret stint singing jazz under a stage name, an unresolved sibling estrangement).
4. Answers are seeded directly into `interview_answers` with `transcript` already set, bypassing `POST /interview-sessions/:id/answers`'s `audioR2Key` requirement on purpose — that endpoint is audio-only and already covered by its own tests; this eval is about question *quality*, not transcription, so real speech synthesis would just add cost and noise as a confound.
5. Ends with a grading pass: a third Claude call compares the full transcript against the ground-truth bio and reports a coverage score, which buried facts got surfaced (and by which question), which life areas stayed thin, and whether any follow-up repeated itself — the last one specifically checks for the "Tour de France" fixation bug round 2 fixed. Writes a full report (transcript + grading) to a timestamped markdown file in `apps/api/`.

## Why it's built this way — pushback that shaped the design

Tim's original framing was to see whether follow-up questions "dig into specific aspects" of the persona's life and recover a full picture that way. That's testing for the opposite of the current, deliberate design: round 2 explicitly moved follow-ups *away* from digging into one specific memory (that's exactly what caused the "Tour de France" fixation bug) and toward staying at the same general-life-question register as the curated bank, extending into whichever life category is thinnest. So this eval's grading pass measures breadth-driven coverage — does asking good general questions across categories eventually surface buried facts — not depth-drilling. If that framing is ever revisited, the eval's grading prompt (bottom of `run.ts`) is the place to change what "good" means.

Also worth knowing: one persona is a thin sample by nature — a single fictional bio's phrasing quirks could flatter or unfairly penalize the system independent of whether the underlying logic is sound. This first version ships with one detailed persona to prove the harness out; running a small set of contrasting archetypes (chatty vs. terse, chronological vs. associative, one who buries an important fact in a single passing mention) would be the natural next step for a more statistically meaningful read, not just a one-off anecdote.

## How to run it

```
cd apps/api
pnpm eval:qa-persona
```

Requires `ANTHROPIC_API_KEY` in the repo root `.env` — the same key `generateFollowUpQuestion` already needs in production, so if the real feature works today this should too. Optional `QA_EVAL_MAX_FOLLOWUPS` (default 12) caps how many generated follow-ups it runs before stopping, since the loop has no natural end otherwise.

You may see harmless `ECONNREFUSED 127.0.0.1:6379` lines in the console if Redis isn't running — that's BullMQ's queue objects (instantiated as a side effect of importing the real `src/index` app, same as the real API process does) trying to connect; the eval itself doesn't touch any queue. If you're running this alongside the normal dev setup (`docker-compose up`), Redis will already be up and this won't appear at all.

## 2026-07-19 fixes, from Tim's first real run

Two real bugs, both found on Tim's first actual run (15 curated + 12 follow-ups, real `ANTHROPIC_API_KEY`):

1. **Grading report cut off mid-sentence.** The grading call's `max_tokens` was a fixed 1200, tuned against a short test run before this script had ever seen a real transcript — a real interview (27 Q&A pairs total) gave the grading pass much more to summarize than that budget covered, and Claude's response was silently truncated mid-word. Fixed: `max_tokens` for the grading call now scales with transcript length (`800 + 120/entry`, capped at 6000) instead of a fixed number.
2. **Terminal hung after "Report written to..." instead of returning to the prompt.** Not actually a hang — the script had already finished everything it needed to do, including writing the report. Importing the real `src/index` app (needed to hit the real endpoints) pulls in every BullMQ queue as a side effect, same as the live API process; those hold open ioredis sockets that keep retrying forever if Redis isn't reachable, or just stay open if it is — either way, nothing was ever going to make Node exit on its own. Fixed with an explicit `process.exit(0)` at the end of a successful run.

Also bumped the default `QA_EVAL_MAX_FOLLOWUPS` from 12 to 25, per Tim's request after seeing the first run — 12 wasn't enough to get much past the "easy" surface-level follow-ups into the thinner areas of the persona's life.

## 2026-07-19 — real bug found and fixed via the eval

Tim's first real full run (15 curated + 25 follow-ups) scored 69/100 and, more usefully, caught an actual product bug: several follow-ups substantively re-asked something already covered — marriage/partnership lessons asked three separate times, "hardest season of life" asked twice with near-identical expected answers, tutoring-identity and Carol-friendship each asked twice.

**Root cause**, confirmed by reading the actual code rather than guessing: `generateFollowUpQuestion`'s prompt already said "do not repeat a question that's effectively already been asked," but the only history it ever saw was `priorQAs` — capped at the 8 most recently answered questions by `interviews.routes.ts` (a deliberate cost/context-size limit, not a bug in itself). Once an interview runs past that cap, anything asked earlier — including from the curated bank — scrolls out of view entirely, and the model has no way to know it's covering old ground again.

**Fix:** `generateFollowUpQuestion` now takes a second list, `priorQuestionTexts` — every question ever asked this person, text and life phase only, no answers, so it stays cheap to include in full even on a long interview. The detailed `priorQAs` context stays capped at 8 for answer-level depth; the new list exists purely so the model can check a candidate question against the complete history before asking it. `interviews.routes.ts` now queries and passes both.

Also closes a real gap both prior adaptive-Q&A handover docs flagged: there was no automated test at all for `GET /interview-questions/next`. Added `apps/api/tests/routes/interviews.test.ts`'s new `GET /interview-questions/next` describe block (curated-first ordering, generated-question reuse, the 204-when-untranscribed case, and — the actual regression guard — a test asserting `priorQuestionTexts` carries all 10 seeded questions while `priorQAs` stays capped at 8) plus a new `apps/api/tests/services/claude.service.test.ts` (prompt construction, quote-stripping, error handling).

Both test files updated again for the category-spread change above (new assertions on `recentCategories`, the returned `{question, lifePhase}` shape, the anti-fixation prompt instruction, and the least-recently-used fallback). One real bug caught in the process: migration 023 first version unconditionally inserted the 30 new questions on every `migrate:latest`, which broke a pre-existing test's assumption that `interview_questions` starts empty — fixed by making the migration a no-op unless the original 15 were already seeded (see its own docstring). Verified against the real pglite suite: `interviews.test.ts` 16/16, `claude.service.test.ts` 6/6.

## 2026-07-19 — curated bank expanded from 15 to 45, across 18 categories

Prompted by the eval's own findings: Robert Chen and the Doreen estrangement never surfaced across two real runs, and it turned out to be structural, not a follow-up-quality problem — the original seven categories (childhood, education, work, relationships, family, values, legacy) simply had no question that could organically invite "was there anyone before your spouse" or "tell me about your siblings." The adaptive follow-up model can only extend a thread that already exists somewhere in the transcript; it has no way to ask about a topic the interviewee has never once mentioned.

Redesigned from first principles: what are the key things you'd need to know to get a grasp on someone's whole life? Eighteen categories, most with 2-3 questions, 45 total (the original 15 kept exactly as-is — real answered history may already reference them by id — plus 30 new). New categories: origins, coming-of-age, romance (pre-marriage), partnership (renamed from the old "relationships"), parenthood, siblings & extended family, friendship across life stages, money & circumstance, health/loss/hardship, historical context, community & faith, passions & private joys, turning points. Three categories — partnership, parenthood, romance — deliberately open with a screening-style question rather than presupposing marriage or children happened at all, per Tim's correction: "don't assume someone got married or spent their life with the same person... first ask."

**Files:** `apps/api/src/db/curatedQuestions.js` (new — single shared source of truth for the question data, imported by both paths below, so they can't drift apart). `apps/api/src/db/seeds/001_interview_questions.js` (rewritten to import from there — fresh dev/test environments get all 45 from scratch). `apps/api/src/db/migrations/023_expand_curated_question_bank.js` (new — the additive path for Tim's own already-seeded real DB, where re-running the seed isn't possible once real answers exist against the original 15's ids: `interview_answers.question_id` has no `ON DELETE CASCADE`, so `del()` would fail loudly rather than corrupt anything, but that also means the seed script is the wrong tool here). The migration re-tags the original 15's `life_phase` onto the new category names (text/ids untouched) and inserts the 30 new ones — deliberately a no-op if the original 15 were never seeded at all (every fresh test-suite DB runs migrations but not the seed script, so without this guard every test file would find 30 uninvited rows already there before its own setup ran — caught this via the real pglite suite, see below).

## 2026-07-19 — follow-up questions now spread across categories

Separate ask, same session: "also try and pick from the 18 categories, don't focus on a single category for too long (maybe 3 questions in a row in a single category before moving to a different one)." Two changes in `apps/api/src/services/claude.service.ts`:

Every generated follow-up used to be stored with a hardcoded `life_phase` of `"generated"` — meaningless for tracking which of the eighteen real categories it actually belonged to, and impossible to enforce a "don't stay in one category" rule against. `generateFollowUpQuestion` now returns `{ question, lifePhase }` (a real category, picked by Claude from the eighteen), not a bare string — the prompt lists all eighteen categories, the recent category sequence, and an explicit rule: if the same category appears for three or more of the most recent questions in a row, pick a different one this time. If Claude's response doesn't parse into one of the eighteen known categories, a deterministic fallback (least-recently-used category, computed in code, no model call) kicks in rather than storing garbage.

`interviews.routes.ts` computes `recentCategories` (the life_phase of the last 6 answered questions, chronological) alongside the existing duplicate-avoidance history, passes both through, and persists whatever category `generateFollowUpQuestion` actually returned instead of the old placeholder.

## 2026-07-19 — retry/resilience fix + follow-up count bumped to 45

A real run hit "Claude returned no text content" 42 questions in (mid-way through the jazz-singing reveal, no less) and the whole script died, losing every answer gathered — expensive to lose given how many paid API calls a long run makes. `callClaude` now retries transient failures (empty content, 5xx, network errors) up to 3 times with backoff, and logs the raw response body (previously swallowed entirely) if it still fails, so a genuinely recurring problem is actually diagnosable. The interview loop and the grading pass are both wrapped so any unrecoverable failure still writes an `-INCOMPLETE.md` report with whatever transcript was gathered so far, rather than losing it outright.

Also bumped `QA_EVAL_MAX_FOLLOWUPS`'s default from 25 to 45, matching the curated bank's own new size — a full run is now up to 90 questions (45 curated + 45 follow-ups) deep.

## 2026-07-19 — the real bug: this failure mode lives in production too

A subsequent run hit the same underlying issue, but this time in `generateFollowUpQuestion` itself (`apps/api/src/services/claude.service.ts`) — the actual `GET /interview-questions/next` endpoint 500'd with "Claude returned no follow-up question text." The eval script's own retry logic only covers its own Claude calls (persona answers, grading); it did nothing for the production function it calls over HTTP. This means any real user could have hit the same 500 on a bad day, not just this eval.

Fixed at the source: `generateFollowUpQuestion` now goes through a new local `callAnthropic` helper with the same retry/backoff behavior as the eval script (3 attempts, short backoff, logs `stop_reason` on final failure instead of a bare "no text"). Two new tests in `claude.service.test.ts` — one confirming the error surfaces cleanly after all 3 attempts are exhausted, one confirming a transient empty response on attempts 1-2 followed by a good one on attempt 3 recovers transparently (the actual regression guard for this exact failure). Verified: `claude.service.test.ts` 7/7, `interviews.test.ts` 16/16 (unaffected, since it mocks the whole module).

## Verification done so far

Ran the harness end-to-end through DB boot, migrations, curated-question seeding, real account registration, real session creation, and the first real `GET /interview-questions/next` call (correctly returned curated question 1) — confirmed all of that plumbing works. Could not run a full persona interview or the grading pass in this sandbox, since neither has a real `ANTHROPIC_API_KEY` configured; the script correctly throws a clear, actionable error at that point rather than failing silently or with a confusing stack trace. **Not yet run for real** — that's the next step, on a machine with the real key.

## What to test next

1. `pnpm eval:qa-persona` from `apps/api`, with `.env` having `ANTHROPIC_API_KEY` set.
2. Read the generated report (`apps/api/qa-persona-eval-report-<timestamp>.md`). Check the coverage score, which buried facts were and weren't surfaced, and specifically the "repeated or near-duplicate questions" section — that's the one that would catch a regression of the round-2 bug.
3. If the follow-ups read as too generic/repetitive or the coverage score is low, that's a real signal about `generateFollowUpQuestion`'s current prompt (`apps/api/src/services/claude.service.ts`), worth iterating on with this eval as the feedback loop rather than guessing from live device testing alone.
4. Consider adding 2-3 more persona archetypes (see "why it's built this way" above) once this first run's results are in, if a single persona's results seem like they might be an outlier rather than representative.

## Files touched

```
apps/api/scripts/personaQaEval/persona.ts    new — ground-truth bio, buried facts, persona-answering prompt
apps/api/scripts/personaQaEval/run.ts        new — the eval script itself
apps/api/package.json                        added "eval:qa-persona" script
docs/handover_2026-07-19-qa-persona-eval.md  new — this file
```

## Git — commands to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia
git add apps/api/scripts/personaQaEval/persona.ts apps/api/scripts/personaQaEval/run.ts apps/api/package.json docs/handover_2026-07-19-qa-persona-eval.md
git commit -m "Add adaptive Q&A persona eval — synthetic interview subject + coverage grading"

git add apps/api/src/services/claude.service.ts apps/api/src/routes/interviews.routes.ts apps/api/tests/services/claude.service.test.ts apps/api/tests/routes/interviews.test.ts
git commit -m "Fix follow-up questions repeating on long interviews

generateFollowUpQuestion only ever saw the 8 most recently answered
questions, so anything asked earlier (including curated ones) was
invisible once an interview ran past that cap - caught by the persona
eval on a real 40-question run (marriage lessons asked 3 times).

Now also passes the full question-text history (no answers, stays
cheap) alongside the capped detailed context, purely for duplicate
checking. Also adds the automated test for GET /interview-questions/next
both prior handover docs flagged as missing - 15/15, plus 4/4 in a new
claude.service.test.ts."

git add apps/api/src/db/curatedQuestions.js apps/api/src/db/seeds/001_interview_questions.js apps/api/src/db/migrations/023_expand_curated_question_bank.js
git commit -m "Expand curated question bank from 15 to 45, across 18 categories

Redesigned from first principles - what are the key things you'd need
to know to get a grasp on someone's whole life. New categories include
origins, coming-of-age, romance before marriage, siblings/extended
family, money/circumstance, health/loss, passions - all things the
persona eval showed the original 7 categories structurally couldn't
surface (Robert Chen, the Doreen estrangement) since the adaptive
follow-up model can only extend a thread that already exists, never
invent one from nothing.

Partnership/parenthood/romance open with a screening question rather
than presupposing marriage or children happened at all, per Tim's
correction.

Original 15 untouched (id/text) since real answered history may
reference them - only life_phase gets re-tagged. New migration handles
the additive path for an already-seeded real DB (the seed script's
del()+insert() can't safely rerun once real answers exist); shares
one data source with the seed script so they can't drift apart."

git add apps/api/src/services/claude.service.ts apps/api/src/routes/interviews.routes.ts apps/api/tests/services/claude.service.test.ts apps/api/tests/routes/interviews.test.ts
git commit -m "Spread follow-up questions across categories instead of fixating

Generated follow-ups were all stored with a hardcoded life_phase of
'generated', with no way to track or enforce category variety.
generateFollowUpQuestion now returns {question, lifePhase} - a real
category out of the 18 - given the recent category sequence, with an
explicit rule against 3+ in a row in one category and a deterministic
least-recently-used fallback if the model's response doesn't parse.

16/16 and 6/6 against the real pglite suite."
```

```powershell
git add apps/api/scripts/personaQaEval/run.ts
git commit -m "Eval: retry transient Claude failures, preserve partial transcript, 45 follow-ups

A real run lost 42 questions of gathered transcript to one bad/empty
API response mid-run. callClaude now retries (3 attempts, backoff) and
logs the raw response on final failure instead of swallowing it. The
interview loop and grading pass are wrapped so any unrecoverable
failure still writes an -INCOMPLETE.md report with whatever was
gathered, rather than losing it. QA_EVAL_MAX_FOLLOWUPS default bumped
25 -> 45 to match the curated bank's own new size."

git add apps/api/src/services/claude.service.ts apps/api/tests/services/claude.service.test.ts
git commit -m "generateFollowUpQuestion: retry transient Claude failures

The same empty-response failure mode the eval script's own calls hit
also lives here, in production - GET /interview-questions/next 500'd
for a real user, not just during the eval. New local callAnthropic
helper (3 attempts, backoff, logs stop_reason on final failure)
replaces the old bare fetch call. Two new tests: one confirming the
error still surfaces cleanly after all retries are exhausted, one
confirming a transient bad response followed by a good one recovers
transparently. 7/7, plus 16/16 in interviews.test.ts (unaffected,
mocks the whole module)."
```

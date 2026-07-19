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

## 2026-07-19 — second-order fix: max_tokens cutoff needs a bigger budget, not just a retry

The plain retry fix above (`callAnthropic`) handled generic transient failures, but a subsequent real run (question 50, deep into the follow-up phase) hit the exact same symptom — "Claude returned no text content" — with `stop_reason: max_tokens` this time. That's a different failure shape masquerading as the same error: the model wasn't flaky, it was cut off mid-response before it ever got to emit a text block, because the fixed 250-token budget wasn't enough room for a longer prompt (by this point in a long interview, `priorQuestionTexts` alone can be dozens of lines). Retrying at the same `max_tokens` three times in a row is deterministic, not transient — it fails identically every time, so the existing retry loop was just burning three API calls to fail once, slowly.

**Fix:** `callAnthropic` (and the eval script's equivalent, `callClaude` in `run.ts`) now distinguishes the two failure shapes. A generic empty response retries at the same budget, unchanged. An empty response specifically caused by `stop_reason: max_tokens` doubles the budget (capped at 2000) before the next attempt, so the retry actually has a chance of succeeding instead of repeating a request that's guaranteed to fail again. Also bumped the starting budget for `generateFollowUpQuestion`'s call from 250 to 500 tokens, and the eval's persona-answering call from 300 to 500, so the escalation path is needed less often in the first place.

Two new tests in `claude.service.test.ts`: one mocks a `stop_reason: max_tokens` empty response followed by success, and asserts the second request's `max_tokens` was actually doubled (500 → 1000) rather than repeated; a second confirms a plain empty response (no `max_tokens` cutoff) does *not* escalate the budget, so the two failure paths stay properly distinguished. Verified against the real pglite suite: `claude.service.test.ts` 9/9, `interviews.test.ts` 16/16 (unaffected, mocks the whole module).

## 2026-07-19 — third-order fix: category pacing (whole-interview, not just streaks) + curated bank gaps, from Tim's first full 90-question run

Tim ran a full real interview (45 curated + 45 follow-ups, real `ANTHROPIC_API_KEY`) end to end for the first time and the grading pass scored it 91/100 — strong (4 of 5 buried facts surfaced, appropriately guarded; the 5th, the stage name and club, staying buried is arguably correct persona-consistency behavior, not a system failure). But the grading pass caught two real, fixable problems:

**Category pacing.** The existing "3 categories in a row" streak rule (see the section above) only ever prevents *consecutive* repeats. It did nothing to stop a category from being revisited over and over with gaps in between — this run picked `community_faith` and `passions` 4 times each out of 45 follow-up slots, and `turning_points` also 4 times, while `parenthood`, `partnership`, and `childhood` only got 1 follow-up each. Concretely: Q40 and Q69 both asked some version of "where did you feel like you belonged," 29 questions apart, and got the same answer (the church basement) both times; Q41/51/62/87 all mined "things you do for yourself" with diminishing new information each time. The streak rule never fired for any of this because no single category ever ran 3-in-a-row — a real pacing bug the streak rule structurally can't see.

**Fix** (`claude.service.ts`): `generateFollowUpQuestion` now also tallies how many times each of the eighteen categories has been asked across the *whole* interview — free to compute, since `priorQuestionTexts` (already passed in for duplicate-checking) already carries every question's life phase. The prompt shows this tally sorted least-to-most and instructs the model to prefer the low end, treating 3 as a soft ceiling for any one category unless every other category already has 3+ too. The deterministic fallback (`leastUsedCategory`, replacing the old `leastRecentlyUsedCategory`) now picks from this same whole-interview tally rather than just the short recent-streak window, for the same reason. No new data or DB query needed in `interviews.routes.ts` — this was purely a `claude.service.ts` change.

Also added: an explicit instruction not to build a new question around a specific anecdote or story detail that already served as the centerpiece of an earlier answer — the same run's Q9 and Q63 both centered on the one "Walter never left a room without turning off the light" story, 54 questions apart. This is a best-effort prompt instruction rather than a mechanically-guaranteed fix (the model only has full visibility into anecdotes via `priorQAs`, still capped at the most recent 8 for cost reasons — a persona with one favorite illustrative story can still resurface it in two questions further apart than that window, and there's no cheap way to track "which anecdotes has this person already told" across an entire long interview without a much larger change). Flagged here as an accepted, not-fully-solved gap rather than overclaiming a fix.

Two new tests in `claude.service.test.ts`: one confirms the whole-interview tally, the "soft ceiling" instruction, and the anecdote-reuse instruction all reach the prompt, and that the model picking a genuinely underused category (`parenthood`, 0 so far, vs. `passions` at 4) is what gets returned; the existing fallback test was updated to actually populate `priorQuestionTexts` with the categories it's asserting against, since the fallback no longer reads `recentCategories` at all.

**Curated bank gaps.** Separately, the grading pass flagged concrete, easy, natural facts that never came up across the whole 90-question interview because no curated question in any of the eighteen categories ever invited them: a rescued-stray-cat childhood story (a specific, rich anecdote left completely untouched), named specific likes/dislikes, and a sensory smell/taste/sound memory. This isn't a follow-up-quality problem the way the Robert Chen / Doreen gaps were (section above) — it's a structural gap in the question bank itself, same category of fix as the 15→45 expansion, just smaller. Added three more curated questions (`SENSORY_AND_SPECIFICS` in `curatedQuestions.js`, sort_order 46-48): a childhood-pet/animal-companion question, a sensory-triggered-memory question, and a specific-likes-and-dislikes question — standard oral-history interviewing techniques for surfacing concrete detail a purely thematic question tends to skip past, not persona-specific padding. `seeds/001_interview_questions.js` now includes these for fresh environments; `migrations/024_add_sensory_and_specifics_questions.js` is the additive path for Tim's own already-seeded real DB, same pattern as migration 023 (no-op if the curated bank was never seeded, skips any question whose text already exists, safe to run more than once).

Deliberately did NOT try to fix two other callouts from the same grading pass — Kessler's shoplifting-spotting skill and the switchboard-operator job, each mentioned once and never revisited — with a curated or follow-up-prompt change. Both are "go deeper on something already mentioned" requests, which is exactly the drill-into-one-specific-memory pattern `docs/handover_2026-07-17-adaptive-qa-round2.md`'s "Tour de France" fixation bug taught this system to actively avoid (see `claude.service.ts`'s docstring on why the adaptive follow-up stays in a general-life-question register rather than zooming into one detail). Building more of that back in for the sake of this one eval run's coverage score would reintroduce the exact failure mode round 2 fixed.

**Second persona, for the "one persona might be an outlier" gap flagged earlier in this doc.** Added `scripts/personaQaEval/personaTerse.ts` — Walter "Bud" Okafor, a deliberately contrasting archetype: terse, literal, chronological, answers 1-3 flat factual sentences with no anecdotal warmth. Where Peggy's five buried facts are protected by reticence (she'll acknowledge a topic exists but deflects — "that's a different story"), Bud's five buried facts are protected only by brevity: he doesn't deflect or dodge anything, he simply states each one plainly, exactly once, with no emotional signposting, if a question specifically invites it, and otherwise never volunteers it — a harder needle for an adaptive system to notice than Peggy's clearly-flagged hedging. `run.ts` now takes an optional persona selector — a CLI arg (`tsx run.ts terse`, what `pnpm eval:qa-persona-terse` uses — no `cross-env` dependency needed, works identically in PowerShell/cmd/bash) or the `QA_EVAL_PERSONA` env var, defaulting to `peggy`. Report filenames now include the persona key (`qa-persona-eval-report-<persona>-<timestamp>.md`) so runs of both don't collide or get confused for one another.

**Not yet run:** Bud's persona eval hasn't been run for real yet (no `ANTHROPIC_API_KEY` in this sandbox) — that's the natural next step, alongside a real re-run of Peggy's to confirm the category-pacing fix actually improves the Q40/Q69/Q41-51-62-87-style repeats on a fresh run.

**Git status as of this fix:** nothing above is committed yet — see the newest commit block at the end of the "Git — commands to run" section below.

## 2026-07-19 — fourth-order fix: the max_tokens escalation ceiling itself was too low

Tim ran `pnpm eval:qa-persona` for real (Peggy, live Anthropic API) after the category-pacing fix above. It got through 65 questions cleanly — including a full watercolor-class Q&A — then died:

```
Error: Claude returned no text content (stop_reason: max_tokens) — cut off before any text was emitted at max_tokens=2000
    at callAnthropic (...claude.service.ts:147:15)
    at generateFollowUpQuestion (...claude.service.ts:287:16)
    at ...interviews.routes.ts:128:24)
Interview loop failed — writing what was gathered so far before exiting.
Report written to apps/api/qa-persona-eval-report-peggy-1784488910344-INCOMPLETE.md
```

The script did the right thing (wrote an `-INCOMPLETE.md` report with all 65 questions rather than losing the run), but the underlying request still 500'd. This is the same failure class as the second-order fix above (stop_reason: max_tokens, zero text emitted) — except this time the *whole* escalation ladder from that fix (500 → 1000 → 2000, maxAttempts=3) got exhausted, not just the first attempt. Working theory: by question 65 the category-balance instructions from the third-order fix above have real teeth — most of the eighteen categories are already at or past the "3 is a soft ceiling" line, so satisfying "pick a near-least-used category, respect the streak rule, and don't reuse an old anecdote" is a harder judgment call for the model, and on this run it pushed the response past 2000 tokens before a complete text block ever came out.

Fix: raised the ladder one more rung — `maxAttempts` 3→4, cap 2000→4000, so escalation now runs 500 → 1000 → 2000 → 4000. Applied in both `claude.service.ts`'s `callAnthropic` (the production code path that actually 500'd) and the eval script's own mirrored `callClaude` in `run.ts`, same as the second-order fix. Added a regression test reproducing the exact question-65 shape (three consecutive max_tokens cutoffs at 500/1000/2000, success on the fourth attempt at 4000) plus updated the "all retries exhausted" test's call-count assertion (3→4). Tim confirmed via `pnpm test`: **[not yet re-run since this fix — next step below]**.

This is a mitigation, not a structural fix — `askedList` (every question ever asked, in full) keeps growing across a long interview with no cap, so the prompt itself keeps getting bigger and the model's task keeps getting harder as more categories hit the soft ceiling. 4000 tokens should have real headroom over what triggered this one failure, but if a future run exhausts *that* ceiling too, the right move is probably capping/summarizing `askedList` on very long interviews rather than doubling the ceiling a third time.

## 2026-07-19 — fifth-order fix: running per-category biography, replacing `askedList` entirely

Tim asked what a real `generateFollowUpQuestion` call actually cost, in dollars, by question 90 of the completed 90-question Peggy run. Reconstructed the exact prompt from the saved transcript (`qa-persona-eval-report-1784484279976.md`) rather than guessing: ~21,600 characters, and the single biggest, only-ever-growing piece of it was `askedList` (every question ever asked, ~1,700 words already at question 90 and uncapped) — not the capped-at-8 `priorQAs` context, which stays flat regardless of interview length. Rough estimate at current Sonnet 5 introductory pricing ($2/$10 per MTok through Aug 31 2026): ~1.4¢ for that one call, climbing every question after with no ceiling. Tim's question: would a running, per-category biography — merged in place rather than appended — flatten that curve, and could it double as a legacy document for the family if the interview subject passes away?

Yes to both, and it closes an existing gap in the same motion: `persons.ai_summary` (migration 003) and `GET /persons/:id/summary` (`persons.routes.ts`) have existed since early in this project as an explicitly-flagged stub — the route's own comment called it "still a stub," and `claude.service.ts` had a dead `generateProfileSummary(_personId)` that only ever threw `"Not implemented"`, never called from anywhere. Nothing had ever been built to actually populate it.

**What changed:**

- **`migrations/026_interview_biography_sections.js`** (new) — one row per `(person_id, life_phase)`. `summary` (text), `asked_question_stems` (native `text[]`, same choice `based_on_answer_ids` on `interview_questions` already made and already proven to round-trip through knex/pg — deliberately not jsonb, sidesteps node-postgres's array-vs-jsonb serialization gotcha rather than working around it), `question_count`.
- **`claude.service.ts`** — two new pure functions (no DB, same convention as `generateFollowUpQuestion`): `updateBiographySectionSummary` folds ONE new Q&A into the existing summary for ONE category, explicitly instructed to tighten/drop older material rather than grow past 5-6 sentences — this is what keeps the cost flat over a long interview instead of growing with it. `synthesizeBiography` assembles all non-empty section summaries into a flowing "who they were" narrative, built from the already-compact sections rather than the raw transcript, so it stays cheap regardless of interview length. The dead `generateProfileSummary` stub is gone, replaced by these two.
- **`generateFollowUpQuestion`** — signature changed: `priorQuestionTexts` is gone, replaced by `biographySections: { lifePhase, summary, askedQuestionStems }[]`. The category tally (`tallyCategoryCounts`) now reads section lengths directly instead of scanning question text — it only ever needed each entry's `lifePhase` anyway, never the text. The prompt's duplicate/anecdote-reuse check now reads each category's own summary + asked-stems list instead of one 89-line flat list.
- **`services/biography.service.ts`** (new) — the DB-orchestrating layer `claude.service.ts` deliberately doesn't have: `recordAnswerInBiography` (upsert one section per answered question) and `getBiographySections` (read side, used by both `/interview-questions/next` and session completion).
- **`jobs/transcribeAnswer.ts`** — `recordAnswerInBiography` is called right where a transcript becomes known (the one place both the synchronous in-session path and the async `/complete` safety-net path both go through), skipped for open-ended answers with no `questionId` (nothing to categorize under), non-fatal via try/catch — same principle as the existing synchronous-transcription try/catch in the `/answers` handler: a Claude hiccup here shouldn't undo a transcript and memory that already saved. Added a `recordBiography` slot to `TranscriptionDeps` (same DI pattern `transcription`/`getBytes` already use) specifically so tests get a fast offline double instead of a real network call — worth calling out since a real `ANTHROPIC_API_KEY` is often present locally even in tests that have nothing to do with Claude (see the second-order fix section above on the pre-existing test failures that exact situation already caused elsewhere).
- **`interviews.routes.ts`** — `GET /interview-questions/next` now reads `biographySections` instead of querying every prior question. `POST /interview-sessions/:id/complete` now regenerates `persons.ai_summary` from the current sections after marking a session complete (non-fatal, same resilience principle) — this is the actual legacy-document delivery: cheap because it's built from compact sections, not a raw transcript, and it lands in the exact endpoint (`GET /persons/:id/summary`) that's already been sitting there waiting for a writer.
- **Tests** — `biography.service.test.ts` (new, DB-backed via `withDb`): first-answer-creates-a-row, second-answer-in-the-same-category-merges-not-duplicates, separate categories stay separate rows, the right data reaches the Claude call, empty-for-a-fresh-person. `claude.service.test.ts`: existing `generateFollowUpQuestion` tests updated to the new `biographySections` shape; new tests for `updateBiographySectionSummary` and `synthesizeBiography` (including "throws rather than calling Claude when every section is empty" — an empty/junk `ai_summary` would be worse than the honest `generated: false` the summary endpoint already returns). `transcription.worker.test.ts`: existing test updated to inject a `recordBiography` double and assert it's called with the right args; two new tests (skips for open-ended answers, doesn't fail the job if the biography update throws). `interviews.test.ts`: the old `priorQuestionTexts`-length test rewritten around seeded `interview_biography_sections` rows; two new tests on `/complete` covering `ai_summary` regeneration and the empty-sections no-op case; the module-level `vi.mock` for `claude.service.ts` extended to include `synthesizeBiography` (a module mock replaces the whole module, so every export the route actually calls has to be listed, not just the one directly under test).
- **`tests/helpers/testDb.ts`** — added `interview_biography_sections` to `resetDb`'s `TRUNCATE` list so it doesn't leak state across tests.

**Not yet done:** no real dollar comparison run yet (would need a fresh 90-question Peggy eval on this branch, measuring the actual prompt size at question 90 against the ~21,600-character baseline above) — worth doing once this is committed and Tim can run the eval for real. Also didn't wire a way to manually trigger `ai_summary` regeneration outside of session completion (e.g. if someone wants it refreshed without starting a new session) — `synthesizeBiography` is exported and DB-orchestration-free, so a future endpoint for that would be a small addition, not a redesign.

**Git status as of this fix:** not committed yet — see the newest commit block at the end of the "Git — commands to run" section below.

## 2026-07-19 — sixth-order fix: the eval script itself never populated the biography, so the live run it was meant to validate regressed hard

Tim ran `pnpm eval:qa-persona` on this branch to check whether the fifth-order fix actually helped. It didn't — it made things noticeably worse. Coverage dropped 91 → 84, and the grading report showed the exact repetition failure mode this whole line of work was supposed to fix, but worse and later in the interview: roughly Q49–Q93 (nearly the entire follow-up portion) substantively re-asked earlier curated questions, six near-identical times each in several cases (meeting Walter: Q8/51/60/69/78/87; siblings/Doreen: eight separate asks; and so on). Tim also flagged the persona's own in-character reactions as a signal something was off: *"Oh, I think you may have asked me this a time or two already today!"*, *"Goodness, you really are determined to get this story out of me one more time!"*

Root cause, found by reading `run.ts` closely: the eval script seeds each answer directly into `interview_answers` (`db("interview_answers").insert(...)`, deliberately bypassing `POST /interview-sessions/:id/answers` since it has no real audio to send — see the file's own header comment, unchanged reasoning). In production, `recordAnswerInBiography` only ever runs inside `transcribeAnswer.ts`'s `processTranscribeJob` — the one place a transcript becomes known, whether synchronously (`/answers`) or via the async queue safety net (`/complete`). The eval script's direct insert never goes through either path, so `interview_biography_sections` stayed completely empty for the entire run. `generateFollowUpQuestion` was correctly reading `biographySections` — there just weren't any: zero coverage signal, zero already-asked stems, for every one of the eighteen categories, for the whole interview. The old `priorQuestionTexts` mechanism it replaced never had this problem, because it queried `interview_answers`/`interview_questions` directly with a raw SQL join — a query that works correctly regardless of how a row got inserted. The new mechanism instead depends on an explicit write-through call, and this eval script's own answer-insertion bypass — chosen for a completely different, legitimate reason (no real audio pipeline to test against) — was a code path nothing had wired that call into.

This is a real fragility worth being honest about, not just a one-off oversight: `interview_biography_sections` is only ever as accurate as every code path that can cause `interview_answers.transcript` to become non-null. Right now there are exactly two — `processTranscribeJob` (production, both entry points) and this eval script's direct insert (now fixed below) — but any future code path that sets a transcript directly (a bulk-import tool, an admin backfill script, a different test harness) would silently reintroduce this exact bug. Flagging as a known risk rather than pretending it's closed; the eval script itself is the fix for now.

**Fix:** `run.ts` now calls `recordAnswerInBiography` explicitly, right after the direct `interview_answers` insert, passing the same `personId`/`personName`/`lifePhase`/`question`/`answer` the production job would have. Not wrapped in the same loose retry-and-continue style as the Claude-call retries elsewhere in this script — a failure here should be loud (logged, but the run continues rather than dying, since losing one category's coverage signal for one question is recoverable, unlike losing the whole transcript).

**Not yet done:** haven't re-run the eval since this fix — that's the actual verification step. Given this makes every answered question do one more real Claude call (the biography-section update), a full 90-question run now makes roughly 90 more API calls than it did before any of this work started (one per curated + generated question, on top of the existing persona-answer and follow-up-generation calls) — worth knowing going in, not a surprise mid-run.

**Git status as of this fix:** not committed yet — folded into a new commit block at the end of the "Git — commands to run" section below, kept separate from the fifth-order fix's commit since this was discovered and fixed afterward, against a live run.

## 2026-07-19 — seventh-order fix: the fix for the sixth-order fix broke DB isolation itself

Tim tried the sixth-order fix and hit a completely different failure before the interview loop even started:

```
error: delete from "interview_questions" - update or delete on table "interview_questions" violates foreign key constraint "interview_answers_question_id_fkey" on table "interview_answers"
detail: 'Key (id)=(f99dfa51-fa8e-4786-a790-bcbc2856fce0) is still referenced from table "interview_answers".'
```

First guess was leftover state from an interrupted earlier run — wrong. Tim tried a fresh terminal and killed any lingering `node` processes; same failure, deterministically. That ruled out staleness and pointed at something structural in a supposedly-fresh boot.

Root cause: the sixth-order fix added `import { recordAnswerInBiography } from "../../src/services/biography.service"` as a **static** top-level import in `run.ts`. `tests/helpers/testDb.ts`'s own docstring spells out exactly why that's unsafe in this file and I'd read it earlier in this same session: `config/env.ts` reads `process.env.DATABASE_URL` once, at module-import time, and static imports are hoisted to the top of a module regardless of where they're written — so application-code imports in this script have always been dynamic (`await import(...)`), placed inside `main()` *after* `createTestDb()` runs, specifically so `config/env.ts` doesn't load until `DATABASE_URL` has already been pointed at the throwaway pglite instance. The static import chain `run.ts -> biography.service.ts -> claude.service.ts -> config/env.ts` broke that ordering: `config/env.ts` evaluated before `main()` ever called `createTestDb()`, read whatever real `DATABASE_URL` was already in `process.env` (Tim's actual local dev database, from `.env`), and froze it into the `env` object. `createTestDb()` then dutifully set `process.env.DATABASE_URL` to the pglite URL — too late; `db/pool.ts`'s Knex connection had already been (or would be) configured from the frozen `env.databaseUrl`, pointed at Tim's real dev DB the whole time.

The FK violation was `seedFn`'s `del()` correctly refusing to delete real `interview_questions` rows that real `interview_answers` in Tim's real dev database actually reference — exactly the scenario migrations 023/024 exist to avoid, just hit from an unexpected direction. Worse than the error message alone suggests: had the curated bank *not* had real answers against it (or an earlier run had never gotten this far), the script would have gone on to register a throwaway eval account and write fake interview sessions/answers straight into Tim's real database with no indication anything was wrong.

**Fix:** moved `recordAnswerInBiography`'s import back to a dynamic `await import("../../src/services/biography.service")` inside `main()`, right alongside the existing dynamic imports of `db/pool.ts` and the seed module, after `createTestDb()`. Added an explicit comment at the top of the file next to the static imports explaining why this one specifically can't join them, so a future edit doesn't reintroduce the same thing a third time.

**Not yet done:** haven't re-verified with a real run yet — this is a static-analysis fix (traced the import chain by hand, confirmed against `testDb.ts`'s own documented ordering requirement) rather than something reproduced and confirmed fixed in this sandbox, since real Anthropic API calls and Tim's own `.env` aren't available here. Worth double-checking, once this runs clean, that `db.migrate.latest()` didn't already apply migration 026 to Tim's real dev DB during the broken run before the `del()` failed — harmless if so (purely additive new table), but worth a quick confirmation rather than assuming.

**Git status as of this fix:** not committed yet — folded into the same new commit block as the sixth-order fix, see the "Git — commands to run" section below.

## 2026-07-19 — eighth-order fix: access token expired mid-run on a long interview

A subsequent run got past the seventh-order fix cleanly (77 questions in, well past where the DB-isolation bug used to bite) and then died differently:

```
Error: GET /interview-questions/next failed: 401 {"error":"Invalid or expired token"}
```

Root cause: `auth.routes.ts`'s `issueTokens` sets the access token's `expiresIn` to `15m`. A 77+ question run makes three real Claude calls per question (persona answer, biography-section update, follow-up generation) plus whatever retry backoff any of those trigger — comfortably enough wall-clock time to outlive a 15-minute token on a run this long, something no earlier, shorter run had lasted long enough to hit.

**Fix:** `run.ts` now tracks `accessToken`/`refreshToken` as mutable state (previously `const`, set once at registration) and wraps the loop's `GET /interview-questions/next` call in a new `fetchNextQuestion()` helper: on a 401, it calls `POST /auth/refresh` with the stored refresh token, swaps in the fresh pair, and retries once. A second 401 immediately after a fresh token surfaces as a real failure rather than looping forever — that would mean something else is actually wrong.

**Result:** re-run completed the full interview end to end (Peggy, 90 questions) with no further script failures. Coverage came back strong; Tim's only callout was that questions 19, 32, 33, 34, 43, 68, and 85 all circled back to the same core fact (leaving college due to her father's failed business) from slightly different framings — judged thematically justified given how central that event is to her story, but collectively repetitive in the answers it produced. Logged here as an accepted result, not a bug to chase — the category-pacing and per-section duplicate-avoidance work earlier in this doc is about not re-asking the *same question*, not about capping how many *different* questions can legitimately lead back to one especially load-bearing fact. Worth watching on future runs/personas rather than acting on now.

**Git status as of this fix:** not committed yet — see the newest commit block at the end of the "Git — commands to run" section below.

## 2026-07-20 — CI failure: biography.service.test.ts's ANTHROPIC_API_KEY mock never actually worked

GitHub Actions failed on this branch — 4 failures, all `recordAnswerInBiography` calls in `biography.service.test.ts` throwing `updateBiographySectionSummary is not configured — set ANTHROPIC_API_KEY`. Never seen locally.

Root cause: this file mutated `process.env.ANTHROPIC_API_KEY` directly in `beforeEach`/`afterEach` — the exact pattern already fixed elsewhere in `claude.service.test.ts` earlier in this doc (the "flaky ANTHROPIC_API_KEY-not-configured tests" section above), just never applied here too. `config/env.ts` reads `process.env` once, at module-import time, into a plain `env` object every other module (including `claude.service.ts`) reads from — never `process.env` directly. Mutating `process.env` after that object already exists does nothing. Locally this was invisible because Tim's real `.env` has a working key, so `env.anthropicApiKey` was already truthy before any test ran regardless of what the beforeEach did. CI has no `.env` and no `ANTHROPIC_API_KEY` secret for this job, which is what actually exposed it.

**Fix:** mocked `config/env.ts` directly, same as the earlier fix — but with one difference from that fix: this file (unlike `claude.service.test.ts`) also needs a real DB connection through `withDb()`, and `src/db/knexfile.ts` reads `env.databaseUrl` from this exact same module. A bare `vi.mock` returning only `{ anthropicApiKey }` would have blown away `databaseUrl`/`nodeEnv`/everything else and broken the DB connection for the whole file. Used `importOriginal()` instead, keeping the real `env` (built after `createTestDb()` has already pointed `DATABASE_URL` at the throwaway pglite instance, since nothing in this file imports `config/env` until `withDb()`'s `beforeAll` dynamically imports `db/pool.ts`) and overriding only `anthropicApiKey`.

## 2026-07-20 — 4 pre-existing R2-credential test failures (same root cause pattern, third time)

Tim flagged 4 known local failures (`collection.test.ts` x2, `memories.test.ts`, `photos.test.ts`) — `photoUrl` coming back as a real signed URL instead of the `null` these tests assert. Same underlying pattern as the ANTHROPIC_API_KEY bugs above, a third time: `r2.service.ts`'s `getClient()` throws only when `env.r2.accountId`/`accessKeyId`/`secretAccessKey` are empty, and `safePresignDownload` (photos.routes.ts/memories.routes.ts/collection.routes.ts) relies on that throw to degrade to `null`. `getSignedUrl` is a pure local signature computation — no network call — so if real R2 credentials are sitting in the repo root `.env` (needed there for actual local dev against a real bucket), `env.r2.*` picks them up the same way `env.anthropicApiKey` did, `getClient()` doesn't throw, and `presignDownload` quietly succeeds with a real-looking signed URL instead of the `null` these tests exist to pin down.

**Fix, at the actual choke point this time rather than per-file:** `tests/helpers/testDb.ts`'s `createTestDb()` already forces deterministic values for `DATABASE_URL`/`NODE_ENV`/JWT secrets before any application code is imported — every route and worker test boots through this one function (`withApp.ts` and `withDb.ts` both call it). Added `process.env.R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY = ""` there too, unconditionally (not `??`-defaulted like the JWT secrets, since these three specifically need to be forced empty regardless of `.env` for the "not configured" test behavior to be deterministic). Fixes all 4 failures in one place instead of four separate per-file mocks; verified no test in the suite expects a successful real-credential presign path (checked `uploads.test.ts` too, since `POST /uploads/presign` also goes through `presignUpload` — its one test only exercises the 400 validation path before reaching that code).

## 2026-07-20 — extending the biography beyond Q&A: direct memory shares + photo captions

Tim's question, after the biography feature above landed: memories can also come from sharing a memory directly (`POST /memories`) or starting from a photo (`collection.routes.ts`'s proposed-memory accept flow) — can those two avenues populate the running biography too, not just the Q&A interview?

Yes, but neither path had what an interview answer gets for free: a `life_phase`. `interview_answers` always traces back to a category through its `question_id` → `interview_questions.life_phase`. `memories` (migration 005) has no such column at all — `provenance_type` describes *how* something was captured (voice/photo/text/ai_generated), not which of the eighteen life-story categories it belongs to. Both alternate paths write into `memories`, completely bypassing `interview_answers`/`interview_biography_sections` entirely.

**Three real design questions, resolved before writing any code:**

1. **How does a freeform memory get a category at all?** New `classifyMemoryCategory(content)` in `claude.service.ts` — cheap Haiku-tier classification (same cost tier as the existing `classifyPhotoScene`), given the memory's text and the same eighteen-category list `generateFollowUpQuestion` already uses. Returns `null` rather than forcing a guess when the content is too thin/vague to confidently place (a bare caption like "Beach day!") — filing something that vague into a specific category would pollute that category's summary rather than inform it.

2. **Whose biography does it belong to — the contributor, or whoever it's about?** A grandchild sharing a memory about grandma should inform grandma's biography, not the grandchild's. `memoryBiography.worker.ts` files under every `memory_persons`-tagged person if any are tagged, falling back to the contributor only when nobody else is (a memory about the contributor's own life, or tagging skipped). `memory_persons` only ever holds *active* tags — a still-pending tag (`holding_space`) correctly doesn't inform anyone's biography yet either, same as it doesn't show on anyone's profile yet.

3. **What about `is_private`?** This is genuinely new territory — `interview_answers` has no privacy flag at all, everything from the Q&A flow was always fair game for the aggregate biography/`persons.ai_summary`. `memories` deliberately has `is_private`, and the whole point of that flag is the contributor chose to restrict who sees it. Folding a private memory into an aggregate document any family member can read (`GET /persons/:id/summary`) would quietly defeat that choice. Decided this without asking, since it's consistent with everything else this codebase already does around privacy (RLS policies, `persons_tree_view`'s opted-out masking): **private memories are always skipped.** Retracted memories are skipped too (a retraction landing between enqueue and processing is a real if rare race).

**One design point that turned out to simplify things:** a photo-sourced memory from the accept flow starts with `content: null` — nothing to classify yet. Rather than needing separate handling for "direct share" vs. "photo, captioned later," the trigger is just "whenever a memory's content becomes non-empty" — `POST /memories` when content is provided at creation, or `PATCH /memories/:id` (the existing endpoint that closed the "photo memories have no way to add a caption" gap, see the section above from before this doc's Q&A-only scope) whenever a caption gets added later. Both routes now enqueue the same job; no changes needed in `collection.routes.ts` at all.

**What changed:**

- **`claude.service.ts`** — new `classifyMemoryCategory(content: string): Promise<InterviewCategory | null>`.
- **`biography.service.ts`** — new `recordMemoryInBiography(trx, { personId, personName, lifePhase, content })`. Deliberately doesn't reuse `recordAnswerInBiography`'s `question` param with a fixed placeholder string: `asked_question_stems` isn't just display text (the "already asked in this category" list `generateFollowUpQuestion`'s prompt shows) — its *length* is also what `tallyCategoryCounts` reads as the whole-interview category tally that drives category-pacing, and `recordAnswerInBiography` dedupes identical stems. A fixed placeholder would silently stop that tally from incrementing after the first memory in any category. Uses a short excerpt of the memory's own content as the stem instead, so each one stays distinct.
- **`jobs/queue.ts`** — new `memoryBiographyQueue` ("memory-biography"), its own queue rather than piggybacking on `embeddingQueue`: both fire from the same route moment, but classification + a biography-summary rewrite is a distinct job family from computing a search embedding, matching this file's existing one-queue-per-job-family convention.
- **`jobs/memoryBiography.worker.ts`** (new) — `processUpdateBiographyFromMemoryJob`: loads the memory, skips (not errors) on no content / `is_private` / `retracted` / unclassifiable content, otherwise classifies once and records under every tagged person (or the contributor). DI'd deps (`classify`/`record`) for offline testing, same convention as `embedding.worker.ts`/`transcribeAnswer.ts`.
- **`routes/memories.routes.ts`** — `POST /memories` enqueues `update-biography` when content is present; `PATCH /memories/:id` enqueues it when content is part of the update and the post-update value is non-empty (guards against an edit that clears content back to null/empty). Both off the request's critical path — classification + the summary rewrite are real Claude calls, same reasoning that already justified `embeddingQueue` for memory embedding rather than awaiting it inline.
- **`jobs/runWorkers.ts`** — registers the new worker.
- **Tests** — `memoryBiography.worker.test.ts` (new): contributor-fallback, tagged-person(s) filing (including 2 tagged people, 2 separate record calls), skip-on-no-content/private/retracted/unclassifiable, unknown-id error. `claude.service.test.ts`: `classifyMemoryCategory` — not-configured, happy path, case/whitespace normalization, explicit `NONE`, unparseable-response-returns-null-not-throws, prompt content. `biography.service.test.ts`: `recordMemoryInBiography` — creates/merges same as an interview answer would, distinct stems per memory (the tally-undercounting regression guard), prompt content. `memories.test.ts`: both routes enqueue (or correctly don't) the new queue.
- **`tests/helpers/queueMock.ts`** — registered `memoryBiographyQueue` in the fake-queue allowlist (`mockQueues()` is an explicit list, not automatic — any route referencing a queue not listed here breaks every test using that route with an "undefined.add is not a function"-shaped failure).

**Not yet done:** no real end-to-end verification yet — this needs a real run (share a memory, confirm `interview_biography_sections`/`GET /persons/:id/summary` actually picks it up) with `ANTHROPIC_API_KEY` and Redis/a worker process actually running, neither available in this sandbox. Static analysis + the new test suite are the only verification so far, same limitation as every fix in this doc. Also worth deciding later, not blocking now: whether a private memory should ever be able to inform a *private*, non-shared view of someone's biography (a two-tier biography) rather than being excluded outright — flagged as a possible future direction, not attempted here.

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

```powershell
git add apps/api/src/services/claude.service.ts apps/api/scripts/personaQaEval/run.ts apps/api/tests/services/claude.service.test.ts docs/handover_2026-07-19-qa-persona-eval.md
git commit -m "callAnthropic: escalate token budget on max_tokens cutoff, raise the ceiling

A real run hit 'no text content' again at question 50, this time with
stop_reason: max_tokens - the model was cut off before emitting any
text at the fixed 250-token budget. Retrying at the same budget three
times is deterministic, not transient - it was guaranteed to fail
identically every time.

callAnthropic (and the eval's callClaude) now doubles max_tokens
specifically when the empty response is a max_tokens cutoff, leaving
plain transient empty responses on the existing same-budget retry
path. Starting budgets bumped 250->500 (generateFollowUpQuestion) and
300->500 (persona answers) so the escalation path is needed less
often.

A second live run (90-question Peggy eval, after the category-pacing
prompt additions below) hit the SAME wall again at question 65, but
this time exhausted the whole ladder: 500 -> 1000 -> 2000 all cut off
with zero text, at the old maxAttempts=3 / 2000-token cap. Deeper into
a long interview the category-balance instructions get harder to
satisfy (most categories already past the soft ceiling), which seems
to make the category choice a harder call for the model and pushed it
past the old ceiling. Ladder is now 500 -> 1000 -> 2000 -> 4000
(maxAttempts 3->4, cap 2000->4000), mirrored in both callAnthropic and
the eval's own callClaude.

Four tests now cover this: budget doubles and the retry succeeds on a
max_tokens cutoff; a plain empty response leaves the budget unchanged;
all retries exhausted surfaces a clear error (now 4 attempts, not 3);
and a new regression test reproducing the exact question-65 shape
(three consecutive max_tokens cutoffs at 500/1000/2000, success on the
fourth at 4000). 10/10, plus 16/16 in interviews.test.ts (unaffected,
mocks the whole module)."
```

```powershell
git add apps/api/src/services/claude.service.ts apps/api/tests/services/claude.service.test.ts
git commit -m "Fix category pacing: whole-interview tally, not just streaks

The existing '3-in-a-row' rule only ever prevented consecutive
repeats. A real 90-question run (45 curated + 45 follow-ups) picked
community_faith and passions 4 times each, and turning_points 4
times, while parenthood/partnership/childhood only got 1 - the
streak rule never fired since no category ever ran 3-in-a-row,
just kept resurfacing every 8-10 questions.

generateFollowUpQuestion now tallies category counts across the
WHOLE interview (free - derived from priorQuestionTexts, no new
data) and instructs the model to prefer the least-used categories,
treating 3 as a soft ceiling. The parse-failure fallback
(leastUsedCategory, replacing leastRecentlyUsedCategory) now uses
this same whole-interview tally instead of just the recent-streak
window. Also added an explicit instruction against reusing the same
illustrative anecdote as the centerpiece of two different
questions (Q9/Q63 both centered on the same 'turning off the
lights' story).

Two new/updated tests in claude.service.test.ts."

git add apps/api/src/db/curatedQuestions.js apps/api/src/db/seeds/001_interview_questions.js apps/api/src/db/migrations/024_add_sensory_and_specifics_questions.js
git commit -m "Add 3 curated questions closing concrete-detail gaps the eval caught

A childhood pet/animal story, named specific likes/dislikes, and a
sensory smell/taste/sound memory never came up across a full
90-question interview - no curated question in any of the 18
categories ever invited them. Standard oral-history interview
techniques for surfacing concrete detail, not persona-specific
padding. Deliberately did not add anything encouraging the adaptive
model to 'go deeper' on something already mentioned once (e.g. the
persona's shoplifting-spotting skill) - that's exactly the
drill-into-one-memory pattern the round-2 'Tour de France' fixation
bug taught this system to avoid.

migrations/024 is the additive path for an already-seeded real DB,
same pattern as migration 023."

git add apps/api/scripts/personaQaEval/personaTerse.ts apps/api/scripts/personaQaEval/run.ts apps/api/package.json
git commit -m "Add a second, contrasting persona for the Q&A eval

Peggy (persona.ts) is warm and associative and deflects on sensitive
topics with clear verbal hedging ('that's a different story') - an
easy tell for an adaptive system to notice. Walter 'Bud' Okafor
(personaTerse.ts) is terse and chronological and never deflects; his
buried facts are protected only by brevity, stated flatly once if
asked the right question, never volunteered otherwise - a harder
needle to find, and the contrasting archetype flagged as a next step
after Peggy's first full run (one persona's phrasing quirks could
flatter or penalize the system independent of whether the underlying
logic is sound).

run.ts takes an optional persona selector (CLI arg or
QA_EVAL_PERSONA env var, defaulting to peggy) - pnpm
eval:qa-persona-terse runs Bud. Report filenames now include the
persona key so runs of both don't collide."

git add docs/handover_2026-07-19-qa-persona-eval.md
git commit -m "Document category-pacing fix, curated bank additions, second persona"
```

```powershell
git add apps/api/src/db/migrations/026_interview_biography_sections.js apps/api/src/services/biography.service.ts apps/api/src/services/claude.service.ts apps/api/src/jobs/transcribeAnswer.ts apps/api/src/routes/interviews.routes.ts apps/api/tests/services/biography.service.test.ts apps/api/tests/services/claude.service.test.ts apps/api/tests/jobs/transcription.worker.test.ts apps/api/tests/routes/interviews.test.ts apps/api/tests/helpers/testDb.ts
git commit -m "Replace unbounded askedList with a running per-category biography

generateFollowUpQuestion's duplicate/anecdote-reuse check used to read
priorQuestionTexts, a flat list of every question ever asked this
person - appended forever, no ceiling. Reconstructed a real call's
actual prompt (question 90 of the completed 90-question Peggy eval)
and confirmed it was the single biggest, only-ever-growing piece of
it (~1,700 words already, dwarfing the capped-at-8 priorQAs context).
Estimated cost at question 90: ~1.4 cents and climbing every question
after, no ceiling.

New migrations/026 table (interview_biography_sections): one row per
(person, life_phase), continuously merged in place rather than
appended to. New pure functions in claude.service.ts -
updateBiographySectionSummary folds one new Q&A into the existing
section, instructed to tighten/drop older material rather than grow
past 5-6 sentences, which is what keeps this flat over a long
interview instead of growing with it; synthesizeBiography assembles
all sections into a flowing narrative. generateFollowUpQuestion now
takes biographySections instead of priorQuestionTexts - same
duplicate-avoidance guarantee (each section's own asked-question
stems), bounded by content instead of by interview length.

New biography.service.ts is the DB-orchestrating layer
(recordAnswerInBiography, getBiographySections) claude.service.ts
deliberately doesn't have. Wired into transcribeAnswer.ts right where
a transcript becomes known (both the synchronous and async-safety-net
paths go through it), skipped for open-ended answers with no
question, non-fatal on failure. New recordBiography slot on
TranscriptionDeps for the same DI-for-testability reason
transcription/getBytes already have it.

Second-order effect, not just a cost fix: this also implements
persons.ai_summary / GET /persons/:id/summary, previously an
explicitly-flagged stub nothing had ever written to
(generateProfileSummary threw 'Not implemented', never called from
anywhere - now removed). POST /interview-sessions/:id/complete
regenerates it from the current sections when a session wraps up -
built from compact sections, not the raw transcript, so it's cheap
regardless of interview length. Doubles as a legacy document for the
family if the interview subject passes away.

10 new/updated tests across biography.service.test.ts (new, DB-backed:
create/merge/separate-categories/empty-for-fresh-person),
claude.service.test.ts (generateFollowUpQuestion tests updated to the
new shape, new tests for both new pure functions), transcription.worker.test.ts
(recordBiography injected and asserted, skip-on-open-ended,
non-fatal-on-failure), interviews.test.ts (biography-sections wiring,
ai_summary regeneration on /complete). testDb.ts's resetDb updated to
truncate the new table."
```

```powershell
git add apps/api/tests/services/claude.service.test.ts
git commit -m "Fix flaky ANTHROPIC_API_KEY-not-configured tests

These deleted process.env.ANTHROPIC_API_KEY and relied on
vi.resetModules() forcing a fresh re-import of config/env.ts to pick
that up - breaks silently whenever a real key is present in the repo
root .env (Tim's own local setup), since env.ts's dotenv.config() only
skips a var that's already set, so the fresh re-import's dotenv.config()
call reloads the real key right back in. Was already one of the
pre-existing failures flagged earlier in this doc; two new tests
(updateBiographySectionSummary, synthesizeBiography) copied the same
broken pattern before this was caught. Mocks config/env.ts directly
instead, sidestepping .env entirely. Fixes all three, confirmed via
pnpm test: down from 7 failures to 4 (the remaining 4 are the
pre-existing, unrelated R2-credential ones)."
```

```powershell
git add apps/api/scripts/personaQaEval/run.ts
git commit -m "Eval: actually record answers into the running biography

generateFollowUpQuestion now reads biographySections instead of
querying interview_answers/interview_questions directly - but this
script seeds each persona answer straight into interview_answers,
bypassing POST /interview-sessions/:id/answers (no real audio to
send) and therefore bypassing transcribeAnswer.ts's
processTranscribeJob, the only place recordAnswerInBiography got
called. interview_biography_sections stayed empty for an entire eval
run as a result - confirmed by a live run that regressed hard
(coverage 91->84) with the exact repetition failure mode this whole
line of work was meant to fix, just later and worse (~Q49-93
re-asking earlier curated questions, six times over in places). The
old priorQuestionTexts mechanism it replaced never had this problem -
it read straight from interview_answers/interview_questions with a
raw SQL join, which works regardless of how a row got inserted.

Calls recordAnswerInBiography explicitly right after the direct
insert, passing what processTranscribeJob would have. Logged but
non-fatal on failure - losing one category's coverage signal for one
question is recoverable, losing the whole transcript isn't.

Known residual risk, not fully closed: interview_biography_sections
is only as accurate as every code path that can set
interview_answers.transcript directly. Right now that's exactly two
paths (processTranscribeJob, and this eval script's insert, now
fixed) - a future bulk-import or backfill tool that sets a transcript
directly would silently reintroduce this same bug.

Second bug, found immediately after the first fix: recordAnswerInBiography
was imported as a static top-level import, which pulls in
biography.service.ts -> claude.service.ts -> config/env.ts before
main() ever calls createTestDb() - breaking the exact ordering
tests/helpers/testDb.ts's own docstring warns about (config/env.ts
reads DATABASE_URL once, at import time; static imports are hoisted
regardless of where they're written). config/env.ts locked onto
Tim's real dev DATABASE_URL instead of the throwaway pglite one, and
the seed script's del() correctly refused to delete real,
already-answered interview_questions rows in his real database - the
FK error that surfaced was the lucky early failure that stopped the
script before it went on to write fake eval data into a real
database. Moved the import back to a dynamic
await import(...) inside main(), after createTestDb(), matching
every other application-code import in this file, with a comment
explaining why this one specifically can't be static."
```

```powershell
git add apps/api/scripts/personaQaEval/run.ts docs/handover_2026-07-19-qa-persona-eval.md
git commit -m "Eval: refresh access token mid-run instead of dying at 15 minutes

A full 90-question run (77 questions in, past the earlier DB-isolation
bug's failure point) died with 'GET /interview-questions/next failed:
401 Invalid or expired token'. Access tokens expire after 15m
(auth.routes.ts's issueTokens); a long run's three Claude calls per
question plus any retry backoff comfortably outlasts that once the
interview runs long enough - no earlier, shorter run had lived long
enough to hit it.

accessToken/refreshToken are now mutable, and the loop's next-question
call goes through a new fetchNextQuestion() helper: on a 401, refresh
via POST /auth/refresh and retry once. A second 401 right after a
fresh token surfaces as a real error instead of looping forever.

Verified: a full re-run (Peggy, 90 questions) completed end to end
with no further script failures. Coverage held strong; Tim's only
callout was 7 different follow-ups (Q19/32/33/34/43/68/85) all
circling back to the same core fact (leaving college over her father's
failed business) - accepted as thematically justified given how
central that event is to her story, not a bug, and documented as
something to keep an eye on rather than something to fix."
```

```powershell
git add apps/api/tests/services/biography.service.test.ts docs/handover_2026-07-19-qa-persona-eval.md
git commit -m "Fix CI failure: biography.service.test.ts's ANTHROPIC_API_KEY mock never worked

GitHub Actions failed with 4 recordAnswerInBiography calls throwing
'not configured' - this file mutated process.env.ANTHROPIC_API_KEY
directly, which does nothing once config/env.ts's env object is
already built (same bug already fixed in claude.service.test.ts
earlier this branch, just not applied here too). Invisible locally
since Tim's real .env has a working key; CI has neither .env nor the
secret, which exposed it.

Mocked config/env.ts directly, but via importOriginal() rather than a
bare vi.mock like the earlier fix - this file also needs a real DB
connection through withDb(), and knexfile.ts reads env.databaseUrl
from this same module. A bare mock would have broken the DB
connection for the whole file; importOriginal() keeps the real env
(built after createTestDb() already pointed DATABASE_URL at the
throwaway pglite instance) and overrides only anthropicApiKey."

git add apps/api/tests/helpers/testDb.ts
git commit -m "Fix 4 pre-existing R2-credential test failures, at the actual choke point

collection.test.ts (x2), memories.test.ts, photos.test.ts asserted
photoUrl: null (the 'R2 not configured' degradation path) but got a
real signed URL back instead - third occurrence of the same root cause
as the ANTHROPIC_API_KEY bugs above: getSignedUrl is a pure local
signature computation, no network call, so real R2 credentials sitting
in the repo root .env (needed there for actual local dev) leak into
env.r2.* the same way env.anthropicApiKey did, and safePresignDownload
never gets the throw it's designed to catch.

Fixed once at testDb.ts's createTestDb() - the one choke point every
route/worker test already boots through - rather than four separate
per-file mocks. R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY forced
empty unconditionally (not ??-defaulted like the JWT secrets, which
intentionally allow override) since these three specifically need to
be deterministic regardless of .env. Verified no test in the suite
expects a successful real-credential presign path."

git add apps/api/src/services/claude.service.ts apps/api/src/services/biography.service.ts apps/api/src/jobs/queue.ts apps/api/src/jobs/memoryBiography.worker.ts apps/api/src/jobs/runWorkers.ts apps/api/src/routes/memories.routes.ts apps/api/tests/helpers/queueMock.ts apps/api/tests/routes/memories.test.ts apps/api/tests/services/claude.service.test.ts apps/api/tests/services/biography.service.test.ts apps/api/tests/jobs/memoryBiography.worker.test.ts docs/handover_2026-07-19-qa-persona-eval.md
git commit -m "Extend the running biography to direct memory shares + photo captions

Q&A answers weren't the only way biographical content enters this
app - a memory can also be shared directly (POST /memories) or start
from a photo (collection.routes.ts's accept flow). Both write into
memories, which unlike interview_answers has no life_phase at all -
provenance_type describes how something was captured, not which of
the eighteen life-story categories it belongs to.

New classifyMemoryCategory (claude.service.ts) - cheap Haiku
classification, same cost tier as classifyPhotoScene - guesses the
category from freeform content, returning null rather than forcing a
guess when it's too vague to place. New recordMemoryInBiography
(biography.service.ts) - doesn't reuse recordAnswerInBiography's
question param with a fixed placeholder, since asked_question_stems'
LENGTH is also what tallyCategoryCounts reads for category pacing and
a fixed placeholder would dedupe every memory in a category down to
one stem, silently undercounting; uses a content excerpt instead so
each stays distinct.

Files under every memory_persons-tagged person if any are tagged
(falling back to the contributor only if nobody else is) - a
grandchild sharing a memory about grandma should inform grandma's
biography, not the grandchild's. Always skips is_private and retracted
memories - new territory interview_answers never needed, since it has
no privacy flag at all; folding a private memory into the
family-readable aggregate summary would quietly defeat the
contributor's choice to restrict it.

New memoryBiographyQueue + memoryBiography.worker.ts, off the request's
critical path (classification + the summary rewrite are real Claude
calls) - same reasoning that already justified embeddingQueue over an
inline await. POST /memories and PATCH /memories/:id both enqueue on
non-empty content; no changes needed in collection.routes.ts at all,
since a photo-sourced memory (content: null at creation) only ever
gets real content via the PATCH path, which already covers it.

New memoryBiography.worker.test.ts, plus new/updated tests in
claude.service.test.ts, biography.service.test.ts, memories.test.ts.
queueMock.ts's fake-queue allowlist updated (mockQueues() is an
explicit list, not automatic).

Not yet verified end-to-end - needs a real run with ANTHROPIC_API_KEY
and a real Redis/worker process, neither available in this sandbox."
```

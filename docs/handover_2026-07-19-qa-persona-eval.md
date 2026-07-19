# myFamiPedia — Adaptive Q&A persona eval (2026-07-19)

A manual eval tool for the adaptive Q&A feature (`docs/handover_2026-07-17-adaptive-qa.md`, `docs/handover_2026-07-17-adaptive-qa-round2.md`), built because Tim wanted a repeatable way to test question quality without waiting on a real interview subject.

## What it is

`apps/api/scripts/personaQaEval/` — not a vitest test (deliberately not named `*.test.ts`, so `pnpm test`/CI never picks it up). It:

1. Boots the same in-memory pglite Postgres the real test suite uses and seeds the 15 curated questions.
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
```

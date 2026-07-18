# myFamiPedia — Handover addendum (2026-07-17, adaptive Q&A round 2)

Picks up directly from `docs/handover_2026-07-17-adaptive-qa.md`. That handover's git commit was never actually completed — Tim hit a stale `.git/index.lock` (left over from a `git status`/`git diff` run from this side against the mounted drive) before `git add`/`commit` ran. **Everything from both handovers is still uncommitted.** Combined git commands are at the bottom of this file — use those instead of the previous handover's, since they cover both rounds.

## What this round investigated and fixed

Tim reported the Q&A flow still surfacing the same "Tour de France" follow-up after the round-1 fixes. Rather than guess, walked through it with direct Postgres queries (`myfamipedia-postgres-1`) instead of assuming:

**Finding 1 — not actually a bug.** One generated follow-up (`f99dfa51...`) had been shown once, never answered (no `interview_answers` row referenced it), so `GET /interview-questions/next` was correctly *reusing* that not-yet-answered question rather than burning another Claude call — that's the designed behavior, not a defect. Tim confirmed separately that his first attempt to answer it was from *before* today's iOS recording-crash fix, which is why it silently never saved.

**Finding 2 — the "advance" bug from round 1 is now genuinely confirmed fixed.** After a full terminal restart, Tim answered the same question again and it correctly moved to a new one. Good signal that the synchronous-transcription fix from round 1 is working as intended.

**Finding 3 — real remaining issue, now addressed.** The follow-up questions kept circling back to the same narrow anecdote (Tour de France) rather than moving through the person's broader life story. Root cause was the prompt itself, not a bug: round 1's fix told Claude to "pick one specific topic and dig into it," which is exactly what kept latching onto the one vivid detail available in test data. Tim's direction: **follow-ups should stay at the same general-life-question level as the curated bank, building a fuller overall picture, not drilling into specific memories/anecdotes.**

## What changed (code)

**`apps/api/src/services/claude.service.ts`** — `generateFollowUpQuestion` prompt rewritten (third iteration; the docstring above the function now documents all three rounds so the next person doesn't re-litigate this). It no longer asks Claude to pick one specific topic to dig into. It now explicitly asks for a question in the same register as the curated bank (childhood, education, work, relationships, family, values, legacy), aimed at building a fuller overall picture, preferring a thin/unexplored life area over zooming into one anecdote. `PriorQA` gained an optional `lifePhase` field so Claude can see which categories are already covered.

**`apps/api/src/routes/interviews.routes.ts`** — the `priorAnswers` query now also selects `q.life_phase`, passed through as `lifePhase` on each `priorQAs` entry.

No new migrations, no mobile changes this round.

## Verification

- Both files syntax-checked via the standalone esbuild binary (sandbox still can't run real `tsc`/`pnpm install` against the mounted drive). Clean.
- Tim confirmed live on-device: "Ok, looks like its working now" after clearing the one stale unanswered generated question and retrying.

## Still open / worth knowing

- **Why `e09a89d9...`'s answer was saved but never transcribed** (`transcript` stayed `NULL`) was never actually root-caused — I asked Tim to check the API terminal log around the timestamp for the `[interviews] synchronous transcription failed for answer ...` line, but the conversation moved on before that was checked. Likely the same stale-pre-restart process as Finding 1/2 above, but if untranscribed answers show up again after a clean restart, check that log line first.
- No automated test yet for `GET /interview-questions/next` (same gap noted in round 1 — now even more worth adding, given how much the underlying logic and prompt have shifted since it was first written).
- Photo-prompted starting point, `few-days`/`few_days` schema mismatch, and a real `tsc --noEmit` pass all remain open from round 1, untouched.

## Combined git — commands for Tim to run (PowerShell)

Covers both this round and the previous handover, since neither has been committed yet.

```powershell
cd C:\Users\leach\myfamipedia
git status
Remove-Item .git\index.lock -ErrorAction SilentlyContinue
git add apps/mobile/app/"(tabs)"/share-story.tsx apps/mobile/app/interview/new.tsx apps/mobile/app/interview/"[personId]"/new.tsx apps/mobile/app/_layout.tsx apps/mobile/app/interview/session/"[sessionId]".tsx apps/api/src/db/migrations/022_generated_questions.js apps/api/src/services/claude.service.ts apps/api/src/routes/interviews.routes.ts apps/api/src/jobs/transcribeAnswer.ts apps/api/src/jobs/transcription.worker.ts apps/api/tests/jobs/transcription.worker.test.ts apps/api/src/services/transcription.service.ts packages/shared/src/apiClient.ts package.json docs/mobile_app_structure.md docs/voice_pipeline.md docs/session_preferences.md docs/handover_2026-07-17-adaptive-qa.md docs/handover_2026-07-17-adaptive-qa-round2.md
git commit -m "Merge Share your story into one screen, add adaptive Q&A follow-ups (curated bank then general-life-question follow-ups), switch transcription to ElevenLabs Scribe v2"
git push
```

Same quoting note as always — `[personId]`, `[sessionId]`, and `(tabs)` need the quotes shown or PowerShell errors on `git add`. The `Remove-Item ... -ErrorAction SilentlyContinue` line is there specifically in case that lock file reappears; harmless if it's already gone.

## Where things stand

Adaptive Q&A is now confirmed working end to end on-device: curated bank in order, then general-life-question follow-ups that build on what's actually been answered without fixating on one anecdote. This closes out the "test the new Q&A implementation" task from round 1. Next open item, if picked up again, is the automated-test gap noted above, or whatever Tim's next round of manual testing turns up.

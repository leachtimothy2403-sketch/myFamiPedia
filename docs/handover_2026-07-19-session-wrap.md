# myFamiPedia — Session handover (2026-07-19)

Standing instructions still apply (`docs/session_preferences.md`): Tim runs all DB/Docker/PowerShell commands himself and pastes output back — this session (and this handover) assumes that workflow continues. Local Postgres container is `myfamipedia-postgres-1`, Redis is `myfamipedia-redis-1` (host ports 5433/6380, both mapped from the containers' internal 5432/6379 — see root `docker-compose.yml`).

**Read this first**, then go deeper via the two detailed docs it summarizes:
- `docs/media_pipeline.md` — the photo/camera-roll pipeline, extensively updated in-place with dated entries (this doc's own convention, not a separate handover per fix).
- `docs/handover_2026-07-19-qa-persona-eval.md` — the adaptive Q&A eval tool and everything it found/fixed, also updated in-place across the session.

This file exists because the session covered two large, mostly-independent arcs back to back and ran long enough that a fresh session picking this up cold would otherwise have to reconstruct a lot of context from git log alone.

## TL;DR — what to check first

1. **A second, later run hit the same "no text content" error again, this time with `stop_reason: max_tokens`** — a deterministic cutoff (wrong to just retry at the same budget), not the transient failure the earlier retry fix handled. Fixed in both `claude.service.ts` and the eval's `run.ts`: escalate (double, capped at 2000) the token budget specifically on a max_tokens cutoff, plain empty responses still retry unchanged. Full writeup and commit command in `docs/handover_2026-07-19-qa-persona-eval.md`'s newest section. Verified: `claude.service.test.ts` 9/9, `interviews.test.ts` 16/16.
2. **Git: nothing else from this session is committed yet** beyond what's noted above and in item 1 — `.gitignore` (excludes `apps/api/qa-persona-eval-report-*.md`) is still uncommitted too. Commit both in one pass:
   ```powershell
   cd C:\Users\leach\myfamipedia
   git add .gitignore
   git commit -m "Ignore generated qa-persona-eval report files"
   ```
   (then run the max_tokens-fix commit command from the other handover doc)
2. **`pnpm migrate` has NOT been confirmed run against Tim's real dev Postgres.** Migration 023 (the curated-bank expansion, 15→45 questions) needs it. Nothing in this session verified that migration actually ran on a real, non-pglite database — only against the ephemeral test DB. **First thing to check with Tim.**
3. **The expanded curated bank and category-diversity follow-up logic have never been exercised live on-device.** Everything is verified against the real pglite test suite (unit + integration level) and via the standalone persona eval script, but not through the actual mobile app / a real interview session yet.

## Arc 1 — camera-roll sync + selective photo picker (see `docs/media_pipeline.md`)

Built the mobile-side trigger for a photo pipeline (Rekognition detection + Claude classification + time/GPS clustering) that existed server-side but had no caller. Then iterated through a long cycle of real bugs found via live device testing, each fixed and verified against the real (pglite) test suite:

- Screenshots polluting the review queue (`camera-roll-sync.tsx` now filters `mediaSubtypes`).
- One sync session splitting into multiple clusters (chunked registration racing against a per-batch clustering trigger) — fixed with a `skipClustering` flag + one explicit cluster-trigger call at the end of a sync.
- The same photo generating both an individual and a cluster proposal — fixed by excluding photos with a pending individual proposal from clustering's candidate pool.
- Non-personal content (documents, maps) clustering as "memories" — fixed with a face-count gate (`face_count > 0` in at least one cluster member), with an explicit accepted tradeoff (a genuine outing where nobody appears in any photo won't surface).
- The same split-cluster symptom recurring via a *different* root cause (async face-detection timing) — fixed with a substantial "extend-or-create" rewrite of the clustering algorithm (`photoClustering.worker.ts`), which now considers already-clustered and not-yet-clustered photos together rather than only ever creating new clusters.
- Cluster review cards showing a non-representative (no-face) photo as the entire visible preview — fixed via SQL ordering.
- A legitimately-small sync result reading as broken — addressed via UI transparency (last-synced timestamp, reset-history action), not a backend change.

Then, once that was stable, built the **selective photo picker**: accepting a cluster-sourced proposal used to attach every one of the cluster's photos to the resulting memory unconditionally. New endpoints `GET /memories/:id/photos` and `DELETE /memories/:id/photos/:photoId` (contributor-only, posthumous-blocked, refuses to drop the last photo) let `collection/compose.tsx` show a thumbnail strip and trim photos that don't belong. 38/38 in `memories.test.ts`.

**Not yet done / open from this arc:** Task #4 in this session's task list, "Verify review-queue photo fix locally," is still marked pending — worth checking whether that's stale or a real loose end.

## Arc 2 — adaptive Q&A: persona eval, question bank redesign, resilience fixes

Full detail and rationale in `docs/handover_2026-07-19-qa-persona-eval.md`. Summary:

**Built a synthetic-persona eval tool** (`apps/api/scripts/personaQaEval/`) — a fictional, extremely detailed interview subject (Margaret "Peggy" Alsop) with several deliberately "buried" facts, run through the real `GET /interview-questions/next` endpoint end to end, graded afterward against the ground-truth bio. Not a vitest test — a manual script (`pnpm eval:qa-persona` from `apps/api`), since it makes real paid Anthropic calls and is non-deterministic.

**Two real bugs the eval caught, both fixed in production code, not just the eval:**
1. Follow-up questions repeating on long interviews — `generateFollowUpQuestion` only ever saw the 8 most recently answered questions, so anything asked earlier (including from the curated bank) was invisible once an interview ran past that cap. Fixed by also passing the full question-text history (no answers, stays cheap) purely for duplicate-checking.
2. A transient "Claude returned no text content" failure — first found in the eval script's own calls, then found to also live in `generateFollowUpQuestion` itself, meaning a real user could 500 on `GET /interview-questions/next` on a bad day. Fixed at the source with a retry/backoff helper (`callAnthropic` in `claude.service.ts`), not just in the eval script.

**Curated question bank redesigned from 15 questions/7 categories to 45/18** — prompted by the eval showing two of five buried facts (a pre-marriage relationship, a sibling estrangement) never surfaced across multiple runs, which turned out to be structural: the original 7 categories had no question that could organically invite either topic, and the adaptive model can only extend a thread that already exists in the transcript. New categories: origins, coming-of-age, romance (pre-marriage), partnership (renamed from "relationships"), parenthood, siblings & extended family, friendship across life stages, money & circumstance, health/loss/hardship, historical context, community & faith, passions & private joys, turning points. Three categories (partnership, parenthood, romance) deliberately open with a screening question rather than presupposing marriage or children happened at all — Tim's explicit correction mid-session. The original 15 are untouched (id/text preserved, since real answered history may reference them); a new additive migration (`023_expand_curated_question_bank.js`) handles rolling this out to an already-seeded real database, since the seed script's `del()+insert()` can't safely rerun once real answers exist.

**Generated follow-ups now spread across the 18 categories** rather than fixating — each one is tagged with its real category (previously a meaningless `"generated"` placeholder), with an explicit rule against 3+ questions in a row in the same category and a deterministic (non-model) fallback if a response doesn't parse.

All of the above verified against the real pglite suite: `interviews.test.ts` 16/16, `claude.service.test.ts` 7/7, `memories.test.ts` 38/38 (from arc 1) — plus the eval script itself run end-to-end multiple times by Tim on real hardware with a real API key, surfacing the bugs above live.

## Git status (verified this session, not assumed)

Checked directly rather than trusting `git status` alone, since this sandbox has repeatedly hit a `.git/index.lock` permission warning against the mounted drive all session (harmless for reads, but worth knowing about if a `git add`/`commit` ever fails with "another git process" — delete `C:\Users\leach\myfamipedia\.git\index.lock` if so). Diffed `HEAD:<path>` against the working-tree file directly for the highest-risk files (`claude.service.ts`, `interviews.routes.ts`, the persona eval script) rather than trusting `git diff --stat` alone. Result: **the working tree exactly matches HEAD** except for this session's final `.gitignore` addition (see TL;DR above). Everything else — including changes I initially expected might be split across several separate commits per my own suggested commit messages — ended up committed, just grouped somewhat differently than suggested (e.g. the category-diversity and retry-resilience changes both landed inside the `6861c34 "Fix follow-up questions repeating on long interviews"` commit rather than as separate commits). Content-wise, nothing is missing.

## Known gaps / what to test next

1. **Run `pnpm migrate` against the real dev Postgres** (not just pglite) and confirm the curated bank actually shows 45 questions with the new category names — this is the single most important unverified step.
2. **Exercise the new curated bank and category-diverse follow-ups live**, through the actual mobile Q&A flow, not just the eval script — confirm the screening-style questions (partnership/parenthood/romance) read naturally in the actual UI, and that a real interview session doesn't feel repetitive or over-long now that there's up to 45 curated questions before follow-ups even start.
3. **The persona eval is still a single fictional persona, one archetype.** Flagged explicitly during design and not yet acted on: results could be an outlier rather than representative. Worth running 2-3 contrasting archetypes (terse vs. chatty, a persona who buries a fact in one passing mention vs. one who doesn't) before trusting any single eval run's coverage score as a real signal.
4. **Task #4 from this session's list ("Verify review-queue photo fix locally") is still pending** — check with Tim whether this is stale or real.
5. Both photo-pipeline and Q&A areas still have older known gaps carried over from before this session (see the "Known gaps" sections in `docs/media_pipeline.md` and prior handover docs) — not re-litigated here.

## Files touched this session (high level — see the two detailed docs for the full per-file breakdown)

```
Arc 1 (camera roll + photo picker):
apps/mobile/app/collection/camera-roll-sync.tsx      new, then heavily iterated
apps/mobile/app/collection/compose.tsx                extended for multi-photo picker
apps/mobile/app.json, _layout.tsx, (tabs)/index.tsx   nav/permission wiring
apps/api/src/routes/collection.routes.ts              skipClustering, cluster-trigger endpoint, preview ordering
apps/api/src/routes/memories.routes.ts                GET/DELETE photos endpoints
apps/api/src/jobs/photoClustering.worker.ts            extend-or-create rewrite, face-count gate
apps/api/src/jobs/faceDetection.worker.ts              re-trigger clustering on face detection
apps/api/src/jobs/sceneClassificationReview.worker.ts  reverse-direction duplicate fix
packages/shared/src/apiClient.ts                       syncCameraRoll, triggerCameraRollClustering
+ corresponding test files, all passing against real pglite
docs/media_pipeline.md                                 updated in place throughout

Arc 2 (Q&A eval + question bank + resilience):
apps/api/scripts/personaQaEval/persona.ts              new — ground-truth persona bio
apps/api/scripts/personaQaEval/run.ts                  new — eval harness, then retry/resilience fixes
apps/api/src/services/claude.service.ts                generateFollowUpQuestion rewrite, callAnthropic retry helper
apps/api/src/routes/interviews.routes.ts                priorQuestionTexts + recentCategories wiring
apps/api/src/db/curatedQuestions.js                     new — shared question-bank source of truth
apps/api/src/db/seeds/001_interview_questions.js        rewritten to use the shared source
apps/api/src/db/migrations/023_expand_curated_question_bank.js  new — additive real-DB path
apps/api/tests/services/claude.service.test.ts          new
apps/api/tests/routes/interviews.test.ts                extended, closing a previously-flagged test gap
apps/api/package.json                                   added "eval:qa-persona" script
docs/handover_2026-07-19-qa-persona-eval.md              new, updated in place throughout

Housekeeping (this doc):
.gitignore                                              ignore apps/api/qa-persona-eval-report-*.md — UNCOMMITTED, see TL;DR
docs/handover_2026-07-19-session-wrap.md                 new — this file
```

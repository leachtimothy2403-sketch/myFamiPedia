# myFamiPedia — Overnight autonomous fixes (2026-07-20)

Four items from a codebase-wide scan for open work (`notImplemented()` stubs, TODOs, "known gaps" sections across the handover docs), picked by Tim as safe to build without him present — no live API keys, no real Redis/Postgres against real data, no human judgment calls. All four are static-analysis-verifiable (esbuild-parsed, matched carefully against the existing test suite's assumptions) but **not run against the real pglite suite in this sandbox** — same limitation as every other fix this week. Run `pnpm test` from `apps/api` to confirm before merging.

## 1. `few-days`/`few_days` schema mismatch — fixed

Flagged in four separate handover docs since 2026-07-17, never fixed: `packages/shared`'s `questionFrequencySchema` (Zod) and `QuestionFrequency` type used `"few-days"` (hyphen), while the real API contract — the DB check constraint (`migrations/012_question_stream_columns.js`), `collection.routes.ts`'s validation, `scheduledJobs.worker.ts`, and both frontends' own locally-defined `QuestionFrequency` types — all use `"few_days"` (underscore).

Turned out to be low-risk once actually traced: nothing outside `packages/shared/src/schemas/person.schemas.ts` and `packages/shared/src/types/collection.ts` imports either the schema or the type — both the web (`useQuestionFrequency.ts`) and mobile (`collection/settings.tsx`) apps define their own local copy with the correct value instead of importing the shared one. That's exactly why the mismatch never surfaced as a live bug; it just sat there, unused and wrong. Fixed both definitions to `"few_days"`, with a comment on each explaining why nothing broke despite the mismatch existing this long. Also fixed a stale `few-days` reference in `docs/api_structure.md`'s route table.

**Files:** `packages/shared/src/schemas/person.schemas.ts`, `packages/shared/src/types/collection.ts`, `docs/api_structure.md`.

## 2. Photo-clustering query bounded by time window — fixed

`docs/media_pipeline.md` section 6 flagged this as a "known remaining cost" from an earlier fix this week: every clustering pass re-fetched the family's *entire* `taken_at`-having, non-pending-individually-proposed photo library, already-clustered or not, so the query grew with total library size rather than staying bounded to the sync backlog. Full writeup, including the two new regression tests, lives in `docs/media_pipeline.md`'s own dated entry for this fix rather than duplicated here — short version: split into two queries (new/unclustered candidates first, naturally bounded to the backlog; already-clustered candidates second, only within a `CLUSTER_LOOKBACK_PAD_DAYS` = 7-day window padded around the *new* candidates' own `taken_at` range, not wall-clock "now" — deliberately anchored that way so syncing a genuinely old family album still finds its own old cluster to extend). Early-returns entirely on a no-op trigger (nothing new to consider) rather than paying for the second query at all.

**Files:** `apps/api/src/jobs/photoClustering.worker.ts`, `apps/api/tests/jobs/photoClustering.worker.test.ts` (2 new tests, file now 19/19), `docs/media_pipeline.md`.

## 3. `POST /collection/question-prompt/:id/answer` — implemented

Previously a bare `notImplemented(spec)` stub. `docs/section2_pipeline.md` section 4 describes the "question stream" — a periodic push-notification nudge drawing from the same curated `interview_questions` bank the full adaptive Q&A interview (`interviews.routes.ts`) uses, answerable by voice or text, landing in `memories`. The sibling read endpoint, `GET /persons/:id/question-prompt` (already built), determines "already answered" by checking `interview_answers` joined through `interview_sessions` — the exact same source of truth the full interview flow uses. Getting the write side wrong here (e.g. writing straight to `memories` with no `interview_answers` row) would have silently reintroduced the repeated-question failure mode a good chunk of this week's other work (`docs/handover_2026-07-19-qa-persona-eval.md`) went into fixing — a nudge-answered question would just get offered again, by this same endpoint or a later full interview session, since nothing would ever mark it answered.

**Design:** reuses the exact same pipeline a structured interview session uses, collapsed into one request — a self-facilitated `interview_sessions` row is created and immediately marked `completed` (there's no ongoing multi-question session for a client to separately close), with one `interview_answers` row for the question being answered.

- **Voice** (`audioR2Key`): same synchronous-transcribe-then-fallback pattern `POST /interview-sessions/:id/answers` already uses (tries `processTranscribeJob` synchronously if ElevenLabs/R2 are configured; otherwise — or on failure — falls back to enqueuing the real `transcriptionQueue` job, since there's no later `/complete` call for this session the way an in-progress multi-question session has to fall back on).
- **Text** (`content`): no transcription step needed, so the `memories` row, `memory_persons` tag, and biography update all happen synchronously in the same request. The `life_phase` is already known from the `interview_questions` row (no classification needed), so this calls `recordAnswerInBiography` directly rather than going through the classify-first path `memoryBiography.worker.ts` uses for freeform, uncategorized memories from `POST /memories`.

**Schema change required:** `interview_answers.audio_r2_key` was `NOT NULL` since migration 008 — correct as long as the only way to answer was the voice-only interview screen, but blocking for a text-only answer. `migrations/027_interview_answers_text_support.js` makes it nullable and adds a `CHECK (audio_r2_key IS NOT NULL OR transcript IS NOT NULL)` constraint — a row must have *something* (audio to eventually transcribe, or a transcript already in hand), never neither. `transcript` itself needed no new column: a text answer just sets it directly at insert time, since it *is* its own transcript.

**Files:** `apps/api/src/db/migrations/027_interview_answers_text_support.js` (new), `apps/api/src/routes/collection.routes.ts`, `apps/api/tests/routes/collection.test.ts` (4 new tests: missing-body 400, unknown-question 404, text-answer full path including the biography call and the "doesn't get offered again" check, voice-answer fallback-to-Q_TRANS path).

**Not yet done:** no real end-to-end verification (needs `pnpm test` at minimum, ideally a live run with ElevenLabs/R2 configured to exercise the synchronous-transcription branch, which this sandbox can't do).

## 4. Administrator "nominate/confirm" stub routes — removed, not implemented

The scan that produced this list of four items flagged `POST /persons/:id/administrator/nominate` and `.../confirm` (both in `persons.routes.ts`) as unbuilt stubs with an existing design doc — reasonable to assume from the surface, but wrong once actually checked. Two things turned out to both be true at once:

1. **The family-administrator role itself is already fully built.** `GET /family/administrator` and `POST /family/administrator/transfer` (further down the same file) implement everything `docs/family_administrator_and_privacy_model.md` section 1 actually calls for — default admin on family-group creation, the three gated actions from section 2 (manual add-from-tree, deceased-profile creation, flags queue), voice-model pause/revoke self-or-admin, and direct transfer to another active family member. Fully tested: `tests/routes/administrator.test.ts`, 11 tests.
2. **What the two stub routes were actually for — a backup/successor administrator nomination with a confirm handshake (`docs/api_structure.md`'s original description: "Person nominates their own administrator" / "Fallback path: closest connected member confirms") — is a different, real feature that the later, more detailed design doc explicitly deferred.** `family_administrator_and_privacy_model.md` section 1: "Transfer/succession (e.g. a backup administrator for redundancy) was discussed and explicitly parked — not in scope for the initial build." Implementing these stubs now would mean building something a real product decision already said not to build yet, not catching up on missed scope.

Removed both stub routes rather than filling them in, with a comment explaining why and pointing at what's actually built (`/family/administrator/transfer`) and what's genuinely still deferred (backup nomination, if it's ever un-parked). Also updated `docs/api_structure.md`'s two stale rows to describe the real, built endpoints instead of the never-built nominate/confirm shape. Zero test coverage existed for the old stub paths (confirmed before removing — nothing in the suite hit them), so nothing regresses.

**Files:** `apps/api/src/routes/persons.routes.ts`, `docs/api_structure.md`.

## Git — commands to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia

git add packages/shared/src/schemas/person.schemas.ts packages/shared/src/types/collection.ts docs/api_structure.md
git commit -m "Fix few-days/few_days schema mismatch in packages/shared

Flagged in 4 handover docs since 2026-07-17, never fixed:
questionFrequencySchema and QuestionFrequency used 'few-days' (hyphen)
while the DB check constraint, API validation, and both frontends all
use 'few_days' (underscore). Low-risk once traced - nothing outside
these two files' own definitions actually imports either one; both
frontends define their own local copy with the correct value instead,
which is exactly why this never surfaced as a live bug. Also fixed a
stale reference in api_structure.md's route table."

git add apps/api/src/jobs/photoClustering.worker.ts apps/api/tests/jobs/photoClustering.worker.test.ts docs/media_pipeline.md
git commit -m "Bound the photo-clustering query by a time window, not the whole library

media_pipeline.md flagged this as a known remaining cost: every
clustering pass re-fetched every taken_at-having photo in the family,
already-clustered or not, so cost grew with total library size rather
than staying bounded to the sync backlog.

Split into two queries: new/unclustered candidates (naturally bounded
to the backlog, and if there are none, skip the second query
entirely), then already-clustered candidates within a
CLUSTER_LOOKBACK_PAD_DAYS (7-day) window padded around the NEW
candidates' own taken_at range - anchored to their dates, not
wall-clock 'now', so syncing a genuinely old family album still finds
its own old cluster to extend rather than silently reintroducing the
split-cluster bug the extend-or-create rewrite exists to prevent.

Two new tests: an old-dated (2019) sync correctly extends its own old
cluster years later; a genuinely distant/unrelated old cluster (2015)
is left untouched by an unrelated recent sync in the same run. Full
file at 19/19."

git add apps/api/src/db/migrations/027_interview_answers_text_support.js apps/api/src/routes/collection.routes.ts apps/api/tests/routes/collection.test.ts
git commit -m "Implement POST /collection/question-prompt/:id/answer

Previously a stub. Reuses the exact same interview_answers/
interview_sessions pipeline the full adaptive Q&A interview uses
(rather than writing straight to memories) since GET
/persons/:id/question-prompt's 'already answered' check already reads
that - getting this wrong would silently let a nudge-answered question
get offered again, the same repeated-question bug a good chunk of this
week's other work went into fixing elsewhere.

Voice (audioR2Key): same synchronous-transcribe-then-fallback-to-Q_TRANS
pattern POST /interview-sessions/:id/answers already uses, collapsed
into one call since this session completes immediately rather than
being left open for a later /complete call to fall back on.

Text (content): no transcription step needed, so the memory and
biography update happen synchronously, right here, using the known
life_phase from the interview_questions row directly (recordAnswerInBiography)
rather than the classify-first path memoryBiography.worker.ts uses for
uncategorized memories.

Migration 027 makes interview_answers.audio_r2_key nullable (was
NOT NULL since migration 008, correct only as long as voice was the
only way to answer) with a CHECK requiring audio_r2_key OR transcript -
a text answer sets transcript directly at insert time, it IS its own
transcript.

4 new tests: missing-body 400, unknown-question 404, full text-answer
path (memory, tag, biography call, and confirms the question isn't
offered again), voice-answer Q_TRANS fallback."

git add apps/api/src/routes/persons.routes.ts docs/api_structure.md
git commit -m "Remove dead administrator nominate/confirm stubs, not implement them

These looked like an unbuilt feature with an existing design doc, but
investigation found two things: the family-administrator role itself
is already fully built (GET /family/administrator, POST
/family/administrator/transfer, 11 tests in administrator.test.ts) -
just as a direct transfer, not a nominate/confirm handshake. What the
stubs were actually for - a backup/successor administrator nomination -
is a real, different feature that
family_administrator_and_privacy_model.md section 1 explicitly parked
('discussed and explicitly parked - not in scope for the initial
build'). Implementing these now would mean building something a real
product decision already deferred.

Removed rather than filled in. Zero test coverage existed for the old
stub paths - confirmed nothing in the suite hit them before removing.
Updated api_structure.md's two stale rows to describe what's actually
built instead."
```

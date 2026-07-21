# myFamiPedia — Live-testing fixes (2026-07-20, second batch)

Three items from Tim's first real pass at `docs/testing_checklist_2026-07-20.md` on a live device/DB, not the overnight autonomous batch. Unlike that batch, these were confirmed against real reported behavior, not just static analysis.

## 1. Biography prompts tightened against fabrication

Tim flagged this directly: the running biography "embellishes... could make up facts that are not true." Checked both prompts in `claude.service.ts` — neither `updateBiographySectionSummary` nor `synthesizeBiography` had any instruction against inventing details, only "keep specific names, dates, and concrete details" (which encourages specificity but never actually forbids fabricating it). Given this is meant to double as a family's legacy document, that's a real risk, not a hypothetical — a model asked for "warm biographical prose" has a real incentive to smooth over gaps with invented connective detail.

Added an explicit anti-fabrication instruction to both prompts: don't invent or infer any name, date, place, relationship, or detail not already present in the source material; smoothing/rephrasing is fine, adding new specifics to fill a gap is not. No schema/behavior change, just prompt wording — verified the existing prompt-content test assertions in `biography.service.test.ts` still hold (they check for substrings unaffected by the addition).

**Files:** `apps/api/src/services/claude.service.ts`.

## 2. Tree tab — removed By person / By decade browsing

Tim's call: too many overlapping ways to browse the same tree data. Kept the structure/graph canvas (`TreeCanvas`), removed the segmented control and both list-based modes entirely. Both were pure client-side reshapes of the same `GET /family-groups/:id/tree` fetch (`treeGrouping.ts`'s `groupByDecade`, plus inline filter/sort for by-person) — no API route to touch, no server-side change at all. Left `treeGrouping.ts` in place (now unused) rather than deleting it, in case it's wanted again later.

Also chased down a plausible false lead: `GET /family-groups/:id/decades` (search.routes.ts) sounds related but is a completely different, already-orphaned endpoint (memory-decade aggregation for a planned search/explore feature that was never wired to any client) — left untouched, not part of this.

**Files:** `apps/mobile/app/(tabs)/tree.tsx`, `apps/mobile/app/(tabs)/_layout.tsx` (stale comment), `docs/mobile_app_structure.md`.

## 3. Retracting a memory now recomputes the biography section it fed — real bug, now fixed

Tim's live finding: retracting a Q&A answer from Manage didn't update the biography — its content just stayed in the summary forever. Root cause: `recordAnswerInBiography`/`recordMemoryInBiography` only ever fold content INTO an existing summary via a Claude call that merges old + new; there was no record of which sentence came from which answer, so there was no way to "subtract" one contribution's influence from the merged prose. This was a known, explicitly flagged gap in this week's own design writeups — now confirmed as a live, reported bug.

The fix has to be a full rebuild, not an edit: migration 028 adds `interview_biography_sources`, one row per contribution (person_id, life_phase, memory_id, stem, raw content) — written by `recordAnswerInBiography` every time it runs (now requires a real `memoryId`, which every current call site already has or creates: `transcribeAnswer.ts`, `collection.routes.ts`'s question-prompt answer route, `memoryBiography.worker.ts`). `recomputeBiographySection` (biography.service.ts) queries that table joined to `memories`, keeping only sources whose memory isn't retracted, and calls a new one-shot rebuild prompt (`rebuildBiographySectionSummary`, claude.service.ts — deliberately takes no `existingSummary` input at all, so nothing a withdrawn contribution influenced can persist into the result). Zero surviving sources deletes the section outright rather than leaving stale prose with nothing behind it.

Wired into both `POST /memories/:id/retract` AND `POST /memories/:id/restore` (symmetric — restoring should bring content back too), non-fatally, same convention as every other Claude-touching call site this week.

**Files:** `apps/api/src/db/migrations/028_biography_sources.js` (new), `apps/api/src/services/biography.service.ts`, `apps/api/src/services/claude.service.ts`, `apps/api/src/routes/memories.routes.ts`, `apps/api/src/jobs/transcribeAnswer.ts`, `apps/api/src/jobs/memoryBiography.worker.ts`, `apps/api/src/routes/collection.routes.ts`, `apps/api/scripts/personaQaEval/run.ts` (eval script now seeds a stand-in `memories` row, matching what production actually creates), plus test updates across `biography.service.test.ts` (new `recomputeBiographySection` describe block), `memories.test.ts` (new `retract/restore recomputes...` describe block), and `memoryBiography.worker.test.ts` (two assertions gained the new required `memoryId` field).

**Not yet done:** no real `pnpm test` run against this in the sandbox (same limitation as always) — run it before merging. Migration 028 needs `pnpm migrate` before any of this works.

## Git — commands to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia

git add apps/api/src/services/claude.service.ts
git commit -m "Tighten biography prompts against fabrication

Tim flagged this directly after live-testing: the running biography
embellishes answers and could invent facts that aren't true. Neither
updateBiographySectionSummary nor synthesizeBiography had any
instruction against inventing details - only 'keep specific names,
dates, and concrete details,' which encourages specificity but never
forbids fabricating it. Real risk for something meant to double as a
family's legacy document.

Added an explicit instruction to both prompts: don't invent or infer
any name, date, place, relationship, or detail not already present in
the source material. Smoothing/rephrasing is fine, adding new
specifics to fill a gap is not. Wording-only change - existing
prompt-content test assertions still hold."

git add apps/mobile/app/(tabs)/tree.tsx apps/mobile/app/(tabs)/_layout.tsx docs/mobile_app_structure.md
git commit -m "Remove By person / By decade browsing from the Tree tab

Tim's call after live-testing: too many overlapping ways to browse the
same tree data. Kept the structure/graph canvas, removed the
segmented control and both list-based modes - both were pure
client-side reshapes of the same GET /family-groups/:id/tree fetch, no
API change needed. Left treeGrouping.ts's groupByDecade/groupByGeneration
in place (now unused) rather than deleted, in case wanted again later."

git add apps/api/src/db/migrations/028_biography_sources.js apps/api/src/services/biography.service.ts apps/api/src/services/claude.service.ts apps/api/src/routes/memories.routes.ts apps/api/src/jobs/transcribeAnswer.ts apps/api/src/jobs/memoryBiography.worker.ts apps/api/src/routes/collection.routes.ts apps/api/scripts/personaQaEval/run.ts apps/api/tests/services/biography.service.test.ts apps/api/tests/routes/memories.test.ts apps/api/tests/jobs/memoryBiography.worker.test.ts
git commit -m "Retracting a memory now recomputes the biography section it fed

Real bug Tim found live-testing: retracting a Q&A answer left its
content sitting in the biography forever - recordAnswerInBiography
only ever folds content IN via an incremental Claude merge, with no
record of which sentence came from which answer, so there was no way
to subtract one contribution's influence from the already-merged
prose. Flagged as a known gap in this week's design docs; now
confirmed as a live, reported bug.

Migration 028 adds interview_biography_sources: one row per
contribution (person_id, life_phase, memory_id, stem, raw content),
written every time recordAnswerInBiography runs (now requires a real
memoryId - every call site already has or creates one).
recomputeBiographySection rebuilds a section from only the sources
whose memory isn't retracted, via a new one-shot rebuild prompt that
takes no existingSummary input at all, so nothing a withdrawn
contribution influenced can persist into the result. Zero surviving
sources deletes the section rather than leaving stale prose behind.

Wired into both retract AND restore (symmetric), non-fatally, same
convention as every other Claude-touching call site this week.

New tests: recomputeBiographySection unit tests (rebuild, delete on
zero-survivors, no-op on missing section) in biography.service.test.ts;
end-to-end retract/restore tests in memories.test.ts; memoryBiography.worker.test.ts's
two toHaveBeenCalledWith assertions updated for the new required
memoryId field."
```

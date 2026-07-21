# myFamiPedia — Manual testing checklist (2026-07-20)

Everything below is verified against the real pglite test suite (324/324) but never exercised through the actual app or a real device — that's the point of this list. Grouped by what you can test through the app UI vs. what's API-only today (no screen exists yet, so those need a direct API call — curl, Postman, whatever you've got).

## 0. Pre-flight

- [ ] `pnpm migrate` against your real dev Postgres, and confirm it completes cleanly (migration 027 makes `interview_answers.audio_r2_key` nullable — worth a quick `\d interview_answers` in psql to confirm the column is nullable and the new `interview_answers_audio_or_transcript_check` constraint exists).
- [ ] `docker-compose up` (or however you run Postgres/Redis locally) so the worker process actually has something to connect to — several items below depend on a real BullMQ worker running (`pnpm --filter api worker` or whatever your dev script is), not just the API process.
- [ ] Confirm `ANTHROPIC_API_KEY` is set — nearly everything below touches Claude somewhere (follow-up questions, biography summaries, memory classification).

## 1. Adaptive Q&A interview + running biography (mobile — fully wired up)

Driven by `share-story.tsx` → `interview/session/[sessionId].tsx`.

- [ ] Start an interview on your own profile. Answer 5-10 curated questions.
- [ ] Confirm follow-up questions start appearing once the curated bank runs out for that category, and that they read as genuinely new (not repeats) — this is the thing this whole week's work was about.
- [ ] Complete the session (`/complete`). Then check the biography actually got written: `GET /persons/:id/summary` (API-only — no profile screen shows this yet, see section 3) should return a real `ai_summary`, not the stub `generated: false` response.
- [ ] Start a **second** interview session on the same profile a bit later, answer a few more questions in a category you already touched. Confirm the follow-up questions don't re-tread the same ground from session 1 — the running biography (not a raw transcript) is what's supposed to carry that memory across sessions now.

## 2. Memory/photo → biography extension (brand new this week — not yet run for real at all)

- [ ] **Share a memory directly** (whatever screen calls `POST /memories`) with a real paragraph of content, tagging the profile it's about. Wait a bit (or check worker logs) for the `memory-biography` queue job to run, then check that profile's `GET /persons/:id/summary` — does the new memory's content show up reflected in the biography? This is the main thing to verify; nothing has run this path with a real Claude key yet.
- [ ] Share a memory and **mark it private**. Confirm it does *not* show up in that profile's `ai_summary` afterward — this is the one privacy behavior this feature depends on getting right, and it's only ever been tested with mocked Claude calls, never a real one.
- [ ] **Photo-cluster path**: accept a proposed photo memory from the review queue (`collection/review.tsx`), then go edit it in compose and add a real caption/description. Confirm *that* triggers the biography update (it has no content at accept time, so nothing should happen until the caption is added).
- [ ] Share a memory with content too vague to categorize (e.g. just "Fun day!") — confirm nothing breaks and no category gets force-filled with junk (should just skip silently; check worker logs for a `skipped: "unclassifiable"` result if you want to confirm directly).

## 3. Question-prompt nudge answer (brand new — API-only, no screen built yet)

There's no mobile/web UI for this at all — `GET /persons/:id/question-prompt` and `POST /collection/question-prompt/:id/answer` exist only as API routes right now. To test, call them directly:

- [ ] `GET /api/v1/persons/:id/question-prompt` — confirm it returns a real unanswered curated question.
- [ ] `POST /api/v1/question-prompt/:questionId/answer` with `{ "content": "some real answer text" }` — confirm 201, a `memoryId` comes back, and the resulting memory shows up in that profile's timeline.
- [ ] Call the GET again — confirm the same question is **not** offered a second time now that it's answered. This is the one behavior most worth confirming; it's the whole reason this was built the way it was.
- [ ] If you want to test the voice path too: `POST` with `{ "audioR2Key": "<a real key you've uploaded>" }` instead of `content`, and confirm it eventually gets transcribed and shows up the same way.

## 4. Photo clustering (bounded query fix)

- [ ] Run a completely normal camera-roll sync with a handful of recent photos from one outing — confirm they still cluster into one card in the review queue, same as always (this fix changed *what gets queried*, not the clustering logic itself, so this should be an unremarkable pass/fail).
- [ ] Harder to verify by hand, but if you want to specifically exercise the new windowing: sync a batch of *old* photos (with real old EXIF dates, e.g. from an actual old album), then later sync a few more old photos from that same old event. Confirm they merge into the same cluster rather than splitting into two — this is the scenario the fix specifically had to keep working correctly.

## 5. Administrator transfer (already fully built + tested — API-only, no screen built yet)

Not something touched this session, but flagging since there's genuinely no UI for it: `GET /api/v1/family/administrator` and `POST /api/v1/family/administrator/transfer` work today, just via direct API call only. Not urgent to test since nothing changed here — just worth knowing if you go looking for a settings screen for it and can't find one, that's expected, not a bug.

## 6. Question frequency (few_days fix)

- [ ] Low priority — this fix corrected dead code in `packages/shared` that nothing actually imported, so there's no behavior change to verify. If you want a sanity check anyway: Settings → question frequency → "Every few days" → save → reload the screen → confirm it still shows "Every few days" (should already have worked before this fix too, on both mobile and web).

## 7. Regression spot-checks (existing flows this week's changes ran through)

- [ ] Normal voice interview answer (the existing `POST /interview-sessions/:id/answers` flow) still requires real audio and transcribes normally — migration 027 only *relaxed* a constraint, shouldn't change this path at all, but worth one pass given it touched a core table.
- [ ] `PATCH /memories/:id` on an ordinary photo memory (add/edit a caption) still re-embeds for search as before — unaffected by the biography-queue addition, but they now fire from the same code block.

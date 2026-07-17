# myFamiPedia — Handover (2026-07-17, adaptive Q&A session)

Standing instructions still apply (`docs/session_preferences.md`): ask for direct file access up front, keep chat output minimal, local Postgres container is `myfamipedia-postgres-1`.

This session's arc: merged the three-screen "Share your story" flow into one, built adaptive Q&A (curated question bank first, then Claude-generated follow-ups once it's exhausted), swapped transcription from OpenAI Whisper to ElevenLabs Scribe, and fixed three real bugs found via live testing on the phone. **Nothing below has been tested end-to-end by Tim yet against the latest code — that's the next session's first job.**

## What changed

**Screen merge — `(tabs)/share-story.tsx`:** the old "Get started" → `interview/new.tsx` ("whose story is this") → `interview/[personId]/new.tsx` (three starting-point choices) hop is now one screen with progressive reveal: pick "My own story" or "Record someone else" (the latter reveals a person picker from the family tree), then the three activity choices appear in place below. `interview/new.tsx` and `interview/[personId]/new.tsx` are emptied to `<Redirect>` stubs, not deleted — this sandbox can't delete files on the mounted drive (Windows junction/permissions limitation, same as noted in earlier addenda), so they're harmless dead redirects rather than gone. `_layout.tsx`'s Stack.Screen registrations for those two routes were removed.

**Adaptive Q&A — new `GET /interview-questions/next?personId=`:** works through the curated bank (migration 008, 15 seeded questions) in `sort_order` first; once exhausted for that person, asks Claude for a follow-up question built from their own life-story answers only (never generic `memories` — see below). New migration **022_generated_questions.js** adds `person_id`/`source`/`based_on_answer_ids`/`created_at` to `interview_questions` so generated follow-ups are scoped per-person and stored as real rows (same table, same FK target as curated ones).

**Continuous flow in-session:** `interview/session/[sessionId].tsx` now calls that same endpoint after every "Stop & save answer" and swaps in the next question at the top of the screen — you can walk through multiple questions without leaving the recording screen. Shows "that's everything for now" once nothing's left.

**Transcription: OpenAI Whisper → ElevenLabs Scribe v2.** Tim confirmed ElevenLabs already covers this in another project (FriendScape) and asked for the swap since the project already needs an ElevenLabs key for voice cloning. `OPENAI_API_KEY` is no longer used anywhere. Also moved transcription from "only at session completion" to **synchronous, on every answer save** (`apps/api/src/jobs/transcribeAnswer.ts`, new — extracted from `transcription.worker.ts` so the reusable function doesn't drag in a second BullMQ `Worker` instance when imported from the API process). This was necessary for adaptive follow-ups to see *this* session's answers, not just stale content from previously-completed sessions. `/complete` still enqueues a queued fallback for anything that didn't transcribe synchronously (missing key, network blip).

## Bugs found and fixed this session

1. **`whereNotIn("id", [null])` matched nothing.** SQL's `x NOT IN (NULL)` is unknown for every row, not true — so on literally anyone's first-ever Q&A tap (empty exclusion list), the curated-question query always came back empty and jumped straight to generating a follow-up before a single curated question had ever been asked. Fixed by only applying `.whereNotIn(...)` when there's actually something to exclude.
2. **Root `package.json` had no `seed` script at all** (only `migrate`) — `pnpm seed` had been failing since it was first mentioned several rounds ago, which is the real reason "no questions proposed" kept recurring. Added `"seed": "pnpm --filter @myfamipedia/api seed"`.
3. **iOS recording crash**: `setAudioModeAsync({ allowsRecording: true })` alone is an "impossible audio mode" on iOS — needs `playsInSilentMode: true` alongside it. Fixed in the session screen.
4. **Follow-ups fixated on an unrelated topic (Tour de France)** because the prompt pulled from the generic `memories` table (any freeform "share a memory" content), not just structured interview Q&A. Fixed — `generateFollowUpQuestion` now only takes `priorQAs`.
5. **Same follow-up question repeated after answering it** — caused by #4's stale-context problem combined with transcription only running at session end, so a same-session follow-up never had fresh text to work from. Fixed by the synchronous-transcription change above.
6. **"Share a memory" button stayed visually highlighted blue no matter which of the three activities you tapped** — it was hardcoded blue as a "primary CTA" style, not an actual selected-state indicator. All three activity buttons now share one neutral style.
7. **`apiClient.ts` read the wrong field for server error messages** (`data?.message` when the server sends `{error: ...}`) — every thrown `ApiError` across both web and mobile showed a generic HTTP status text instead of the real message. Fixed to check `data?.error` first.

## Product decisions made along the way (for context, not action)

- Follow-ups should always dig into one specific interesting topic, not ease in from broad to specific — an earlier "ease in gradually" request was explicitly superseded by this.
- Photo capture ("Start with a picture and talk about it", and the mid-recording "Take or add a photo" button) is still an intentional stub — separate scope, not touched this session.

## Files touched

```
apps/mobile/app/(tabs)/share-story.tsx                     rewritten
apps/mobile/app/interview/new.tsx                           emptied to redirect
apps/mobile/app/interview/[personId]/new.tsx                emptied to redirect
apps/mobile/app/_layout.tsx                                  removed 2 Stack.Screen entries
apps/mobile/app/interview/session/[sessionId].tsx            rewritten (audio mode fix, continuous advance, personId param)
apps/api/src/db/migrations/022_generated_questions.js        new
apps/api/src/services/claude.service.ts                      generateFollowUpQuestion added + revised
apps/api/src/routes/interviews.routes.ts                     GET /interview-questions/next added; answers/complete updated
apps/api/src/jobs/transcribeAnswer.ts                         new (extracted from transcription.worker.ts)
apps/api/src/jobs/transcription.worker.ts                     slimmed to Worker wiring only
apps/api/tests/jobs/transcription.worker.test.ts              import path updated to match
apps/api/src/services/transcription.service.ts                OpenAI Whisper -> ElevenLabs Scribe v2
packages/shared/src/apiClient.ts                              error-message field fix
package.json (root)                                           added missing "seed" script
docs/mobile_app_structure.md                                  updated for new screen structure
docs/voice_pipeline.md                                        updated for ElevenLabs STT swap
docs/session_preferences.md                                   added Postgres container name
```

## Verification done so far

- Every changed/new file syntax-checked via a standalone esbuild binary in the sandbox (this environment can't run a real `tsc`/`pnpm install` against the mounted drive — Windows junction issue noted in every prior addendum). All clean.
- Confirmed the two Postgres counts that diagnosed the seed bug (`SELECT count(*) FROM interview_questions WHERE source='curated'` and the answers equivalent, both 0 before the fix).
- Confirmed existing `apps/api/tests/routes/interviews.test.ts` assertions about `/complete`'s queue behavior still hold under the new synchronous-transcription code path, by checking that `ELEVENLABS_API_KEY`/`R2_ACCOUNT_ID` are unset in the test environment (the new sync-transcribe call is gated behind both being present, so it's a no-op there — no test changes needed beyond the worker test's import path).
- **Not done**: an actual `tsc --noEmit` pass, and no automated test exists yet for the new `GET /interview-questions/next` endpoint itself (only manual/live testing so far).

## What to test next (the actual next step)

1. `npx pnpm@9.15.9 install` (ElevenLabs/AWS SDK deps from earlier rounds), `npx pnpm@9.15.9 migrate` (needs 022), confirm `.env` has `ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY` set (both should be already, per this session), restart API + workers, `expo start -c`.
2. Share tab → My own story → Q & A → should start at curated question 1 ("What is your earliest memory?"), not jump to a generated follow-up.
3. Answer a couple of curated questions in one continuous session (don't hit "Finish session" between them) — confirm the next question appears automatically each time, and confirm none of the three activity buttons stay stuck highlighted.
4. Answer all 15 curated questions, then confirm the next one is a Claude-generated follow-up that's clearly about something you actually said in this app (not an old unrelated "share a memory" recording), and reads as a single specific, well-formed question.
5. Answer that follow-up, confirm the *next* one is a genuinely different question (not a near-duplicate) — this is the bug that was hardest to pin down, worth double-checking carefully.
6. Try "Record someone else" end to end (person picker → three choices → session) — this path hasn't been manually tested since the screen merge.
7. General regression check on anything from earlier rounds (relationship display, tree view, notifications) — not expected to be affected by this session's changes, but worth a glance given how much of `interviews.routes.ts` moved around.

## Known gaps (not this session's scope, just flagging)

- No automated tests for `GET /interview-questions/next` — worth adding once the manual pass above confirms the behavior is right, since this is exactly the kind of subtle logic (the `whereNotIn`/NULL bug) that a test would have caught immediately.
- Photo-prompted starting point and mid-recording photo capture are still stubs.
- `few-days`/`few_days` schema mismatch — flagged in an earlier round, still not fixed, still low risk.
- Real `tsc --noEmit` hasn't been run against any of this session's changes on an actual machine.

## Git — commands for Tim to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia
git status
git add apps/mobile/app/"(tabs)"/share-story.tsx apps/mobile/app/interview/new.tsx apps/mobile/app/interview/"[personId]"/new.tsx apps/mobile/app/_layout.tsx apps/mobile/app/interview/session/"[sessionId]".tsx apps/api/src/db/migrations/022_generated_questions.js apps/api/src/services/claude.service.ts apps/api/src/routes/interviews.routes.ts apps/api/src/jobs/transcribeAnswer.ts apps/api/src/jobs/transcription.worker.ts apps/api/tests/jobs/transcription.worker.test.ts apps/api/src/services/transcription.service.ts packages/shared/src/apiClient.ts package.json docs/mobile_app_structure.md docs/voice_pipeline.md docs/session_preferences.md docs/handover_2026-07-17-adaptive-qa.md
git commit -m "Merge Share your story into one screen, add adaptive Q&A follow-ups, switch transcription to ElevenLabs Scribe v2"
git push
```

Same bracket/paren quoting note as prior addenda — `[personId]`, `[sessionId]`, and `(tabs)` all need quotes in PowerShell or `git add` errors.

# myFamiPedia — Overnight session (2026-07-22): clarifying follow-ups + two API-only UIs

Three explicit asks from Tim before bed, plus a survey that turned up nothing else safe to build unsupervised (see section 4). As always in this sandbox: not run against the real `pnpm test` suite — run that first thing, along with `pnpm migrate` for the new migration, before trusting any of this.

## 1. Clarifying follow-up (the big one — designed over several messages, built tonight)

Right after an answer in the "Tell your story" flow, a cheap Claude check looks for one specific, nameable fact the answer left out (a name, place, or date) worth asking about. Pairs with the anti-fabrication prompt fix from earlier this week — better to get the real detail from the storyteller directly than let the summarizer guess or leave a permanent gap.

**Bounds, exactly as discussed:** at most one clarification per answer, never chained off a clarification's own answer. A session-wide soft cap (`SESSION_CLARIFICATION_CAP = 4`, `clarification.service.ts`) so a long interview doesn't start to feel like it's constantly double-checking things. A skip-streak backoff (`SKIP_STREAK_BACKOFF_THRESHOLD = 2`) — two skips in a row stops clarifications entirely for the rest of that session, a real "not right now" signal, not something to push through. Skip is a single tap, equal visual weight to answering, no explanation required.

**Schema (migration 029):** `interview_answers.clarifies_answer_id` (self-referencing, nullable — marks an answer as responding to a clarification) and `.clarifying_question` (the generated text, persisted on the *original* answer). `interview_sessions.clarifications_offered_count` / `.clarifications_skip_streak` for the caps above.

**Merge into the biography:** no special "amend" logic needed — a clarification's answer just runs through the same `recordAnswerInBiography` call as any other answer, in the same `life_phase`, with a stem noting it's a clarification. The function's existing incremental-merge design (folds new content into existing prose naturally) does the "reads as one clean passage" work for free.

**A real, useful side effect:** `POST /interview-sessions/:id/answers` now also accepts `content` (text) as an alternative to `audioR2Key` — added so a one-word clarification (a name) doesn't force re-recording voice, but it's a general capability now, not clarification-specific. New endpoint: `POST /interview-sessions/:id/answers/:answerId/skip-clarification`.

**Mobile:** `interview/session/[sessionId].tsx` shows the clarifying question as a full-screen interstitial (a "QUICK ONE" card, text input, Skip/Answer buttons of equal weight) between an answer and the next question. Recording controls and the question itself stay hidden until it resolves.

**Files:** `apps/api/src/db/migrations/029_clarifying_followups.js`, `apps/api/src/services/claude.service.ts` (`generateClarifyingQuestion`), `apps/api/src/services/clarification.service.ts` (new), `apps/api/src/jobs/transcribeAnswer.ts` (refactored — shared `finalizeTranscribedAnswer` now used by both the voice path and the new text path), `apps/api/src/routes/interviews.routes.ts`, `apps/mobile/app/interview/session/[sessionId].tsx`. Tests: `tests/services/claude.service.test.ts` (new describe block), `tests/services/clarification.service.test.ts` (new file — caps, backoff, no-chaining), `tests/jobs/transcription.worker.test.ts` (new describe block), `tests/routes/interviews.test.ts` (text-answer path, skip endpoint, `clarifiesAnswerId` reset).

**Bug caught and fixed along the way:** `transcription.worker.test.ts`'s `recordBiography` assertion was already stale — the retraction fix two nights ago added a required `memoryId` param to `recordAnswerInBiography` but that test's exact-match assertion never got updated, so it would have failed the moment it actually ran for real. Fixed to `objectContaining` (and updated the expected value), which also makes it more resistant to the same class of bug in the future.

## 2. Question-prompt nudge — now has a screen

`GET /persons/:id/question-prompt` and `POST /question-prompt/:id/answer` were built and tested but API-only. Now a compact "TODAY'S QUESTION" banner at the top of the Share hub (own profile only) — text input + Answer button, hidden entirely when there's no unanswered question left. Deliberately not a 4th hub button: this is a lightweight aside, not a whole activity on the same footing as "Share a memory" or "Tell your story," same treatment as the existing conditional "Photos to review" button.

**Files:** `apps/mobile/app/(tabs)/share-story.tsx`, `packages/shared/src/apiClient.ts` (`getQuestionPrompt`, `answerQuestionPrompt`).

## 3. Family administrator transfer — now has a screen

`GET /family/administrator` and `POST /family/administrator/transfer` (11 tests, `administrator.test.ts`) were fully built but API-only. New screen (`family/administrator.tsx`), reachable from Account → "Family administrator": shows the current admin; if you're the admin, a list of other active family members with a one-tap Transfer action and a plain-language warning that it's immediate. No nomination/confirmation handshake — matches the API exactly (that's a separate, explicitly-parked feature per `family_administrator_and_privacy_model.md` section 1, not something this screen invents).

**Files:** `apps/mobile/app/family/administrator.tsx` (new), `apps/mobile/app/(tabs)/account.tsx`, `apps/mobile/app/_layout.tsx`.

## 4. Survey for more work — came up empty, on purpose

Checked for remaining `notImplemented()` stubs, TODO/FIXME comments, and stale gaps across the API, mobile, and docs. What's left is either credential-blocked (magic-link email, R2 object cleanup — need real infra Tim has to provide), explicitly tabled by an earlier product decision (privacy-tier redefinition), or genuinely needs UX judgment (`interview/session/[sessionId].tsx`'s mid-answer photo capture stub — camera permission flow and image-quality tradeoffs aren't mine to decide unsupervised). Also confirmed: none of tonight's three mobile-only features (or last night's Share-tab redesign) have been mirrored to web — it's genuinely stale on all of them, and deciding what web's equivalent should even look like is a real design call, not a port. Didn't manufacture scope to fill the night — stopping here.

## Not yet done / worth knowing

- No real device/manual test of any of tonight's three features — same limitation as every build this week, verify for real before relying on it.
- The clarifying-question prompt is deliberately conservative (should say NONE far more often than not) but has never been checked against a real transcript at volume — worth watching the first few real sessions to see if it's calibrated right, not just correct in principle.
- Migration 029 needs `pnpm migrate` before any of this works.

## Git — commands to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia

git add apps/api/src/db/migrations/029_clarifying_followups.js apps/api/src/services/claude.service.ts apps/api/src/services/clarification.service.ts apps/api/src/jobs/transcribeAnswer.ts apps/api/src/routes/interviews.routes.ts apps/mobile/app/interview/session/[sessionId].tsx apps/api/tests/services/claude.service.test.ts apps/api/tests/services/clarification.service.test.ts apps/api/tests/jobs/transcription.worker.test.ts apps/api/tests/routes/interviews.test.ts docs/api_structure.md
git commit -m "Implement clarifying follow-up questions in Tell your story

Designed with Tim over several messages before building: right after an
answer, a cheap Claude check (generateClarifyingQuestion) looks for one
specific, nameable fact left out (a name, place, or date) worth asking
about. Pairs with this week's anti-fabrication prompt fix - better to
get the real detail from the storyteller than let the summarizer guess
or leave a permanent gap.

Bounded on purpose: at most one clarification per answer, never
chained off a clarification's own answer (clarifies_answer_id,
migration 029). A session-wide soft cap (SESSION_CLARIFICATION_CAP=4)
and a skip-streak backoff (two skips in a row disables it for the rest
of the session) - a real 'not right now' signal, not something to push
through. Skip is one tap, equal weight to answering.

No special merge logic needed for a clarification's answer - it runs
through the same recordAnswerInBiography call as any other answer, in
the same life_phase; the function's existing incremental-merge design
does the 'reads as one passage' work for free.

Side effect: POST /interview-sessions/:id/answers now also accepts
content (text) as an alternative to audioR2Key, so a one-word
clarification doesn't force re-recording voice - a general capability,
not clarification-specific. transcribeAnswer.ts refactored: both the
voice and text paths now funnel through a shared finalizeTranscribedAnswer.

Caught and fixed a stale test assertion along the way:
transcription.worker.test.ts's recordBiography check never got updated
when the retraction fix added a required memoryId param two nights ago
- would have failed the first time it actually ran. Fixed to
objectContaining, more resistant to the same class of bug going forward."

git add apps/mobile/app/(tabs)/share-story.tsx apps/mobile/app/family/administrator.tsx apps/mobile/app/(tabs)/account.tsx apps/mobile/app/_layout.tsx packages/shared/src/apiClient.ts
git commit -m "Build mobile UI for question-prompt nudge and administrator transfer

Both were fully built and tested API-only, flagged on the testing
checklist as untestable through the app. Question-prompt: a compact
'today's question' banner on the Share hub (own profile), hidden
entirely when nothing's unanswered - deliberately not a 4th hub
button, this is a lightweight aside not a whole activity. Administrator
transfer: new screen off Account, shows the current admin, lets the
current admin transfer to another active member with a plain warning
that it's immediate. No nomination/confirmation handshake - that's a
separate, explicitly parked feature, not something this screen invents."
```

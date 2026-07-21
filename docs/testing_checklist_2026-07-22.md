# myFamiPedia — Manual testing checklist (2026-07-22, overnight clarifying-followups batch)

Covers only last night's three items — everything from the 2026-07-20 checklist still applies if you haven't gone through it. Verified against pglite tests (once you've run `pnpm test`), never exercised for real with live keys until now.

## 0. Pre-flight

- [ ] `pnpm migrate` — picks up migration 029 (`clarifies_answer_id`/`clarifying_question` on `interview_answers`, the two new counters on `interview_sessions`). Worth a quick `\d interview_answers` / `\d interview_sessions` in psql to confirm.
- [ ] `pnpm test` from `apps/api` — confirm still green before testing live.
- [ ] Worker process running, `ANTHROPIC_API_KEY` / `ELEVENLABS_API_KEY` / R2 vars all set (you confirmed keys are in place — this is just a sanity check that the worker process itself picked them up).

## 1. Clarifying follow-ups (Tell your story)

- [ ] Start a session (Share → Tell your story), answer a question with something that clearly leaves out a nameable fact — e.g. "A friend of mine helped me move that year" (no name given). Confirm a "QUICK ONE" card appears asking for the missing detail before the next question shows up.
- [ ] Answer the clarification (type a name) — confirm it goes through, the next real question then appears, and afterward `GET /persons/:id/summary` (or just re-reading the profile once it's rebuilt) reflects the added detail woven into the same passage, not as a separate fragment.
- [ ] On a different answer, tap **Skip** instead — confirm it's just as easy (one tap, no confirmation dialog) and the next question appears normally.
- [ ] Answer several questions in a row with ordinary, complete answers (nothing vague) — confirm most of them do **not** trigger a clarification. This should be the common case, not the exception; if it's firing on nearly every answer, the prompt needs tightening.
- [ ] Skip two clarifications in a row (if you get offered that many) — confirm clarifications stop being offered for the rest of that session (the backoff). A fresh session afterward should offer them again normally.
- [ ] Answer enough questions to hit the session-wide cap (4 clarifications offered) — confirm the 5th+ eligible answer just doesn't get one, no error, nothing broken.

## 2. Question-prompt nudge (Share hub banner)

- [ ] Open the Share tab on your own profile — confirm a "TODAY'S QUESTION" card appears above the three hub buttons (assuming you have an unanswered curated question left).
- [ ] Answer it via the text box — confirm it saves, the card either shows the next question or disappears if none are left, and the resulting memory shows up in your own timeline.
- [ ] Once every curated question is answered, confirm the banner disappears entirely rather than showing something broken or empty.

## 3. Administrator transfer

- [ ] Account → "Family administrator" — confirm it shows the current administrator by name, with "(you)" if that's you.
- [ ] As the administrator, confirm you see a list of other active family members with a "Transfer" action, and the plain-language warning that it's immediate.
- [ ] Transfer to someone else — confirm it succeeds, the screen updates to show them as administrator, and if you check as the OLD administrator afterward, admin-only actions (e.g. the flags queue) now correctly reject you.
- [ ] As a non-administrator, confirm you see the read-only "only the current administrator can transfer" message and no transfer list.

## 4. Regression spot-checks

- [ ] A completely ordinary voice-recorded interview answer (no text) still works exactly as before — records, uploads, transcribes, next question appears. The text-answer addition to `POST /interview-sessions/:id/answers` was meant to be purely additive.
- [ ] The existing Q&A adaptive follow-up (once the curated bank runs out) still appears correctly and isn't confused with the new clarifying-question interstitial — they should read as clearly different things (a normal question vs. the "QUICK ONE" card).

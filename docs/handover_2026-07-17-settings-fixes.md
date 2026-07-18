# myFamiPedia — Handover addendum (2026-07-17, third session)

Continuation of `docs/handover_2026-07-17.md` and `docs/handover_2026-07-17-mobile-profile.md` (same day — you asked for an hour of autonomous work while testing the mobile profile screens from the previous session).

## What changed — and why it mattered

Went looking at the settings/voice screens your punch list flagged as "scaffolded but not wired to real data," and found the same class of bug the tree tab had before last session: several screens call the API with a hardcoded literal `"me"` instead of the real person/family-group id. That's not a cosmetic gap — several of the affected endpoints explicitly check `req.params.id === req.auth.personId` (or `familyGroupId`) and return **403** otherwise, so these screens were non-functional, not just unstyled. Fixed with the same pattern last session established: decode the real id out of the JWT via `session.ts` (web, sync) / `useSessionIds()` (mobile, async).

**Web (`apps/web/src/routes/settings/`):**

* **`privacy.tsx`** — was `usePrivacyTier("me")`, always 403'd on save. Now resolves `getPersonId()`. Also added a question-frequency control on the same page (new hook: `apps/web/src/hooks/useQuestionFrequency.ts`) — the API route (`GET`/`PATCH /persons/:id/question-frequency`, `apps/api/src/routes/collection.routes.ts`) already existed but had no frontend at all.
* **`voice.tsx`** — was `useVoiceModel("me")` and `ConsentFlowModal personId="me"`. The consent endpoint explicitly 403s on anything but your own id, so consent could never actually be recorded through this page. Now resolves `getPersonId()`.
* **`subscription.tsx`** — was hardcoded to `/family-groups/me/subscription`, always 403'd. Now resolves `getFamilyGroupId()`. Also added the missing `invalidateQueries` after a successful takeover — previously the status shown wouldn't refresh without a manual reload.
* **`notifications.tsx`** — no id bug here (notifications are user-scoped off the JWT server-side, not person-scoped), but the checkboxes used `defaultChecked` with no `onChange` — toggling one silently did nothing. Wired to `PATCH /notifications/settings`.

**Mobile:**

* **`app/(tabs)/account.tsx`** — "Voice settings" linked to `/voice/me/settings`, same bug, one level up (at the navigation call site rather than inside the screen). Now resolves `personId` via `useSessionIds()` before navigating; the button no-ops until it resolves rather than navigating somewhere broken.
* **`app/collection/settings.tsx`** — was a pure static placeholder ("Privacy tier and question-stream frequency controls render here."). Built out for real: privacy tier + question frequency, same two endpoints as web's fixed `privacy.tsx`, both waiting on `useSessionIds()` since both endpoints have the same self-only 403 check.

**Not touched, and why:** the moderation queue (web and mobile) was already correctly wired — no id param needed for `/flags`, so it didn't have this bug. Left it alone. Also didn't touch `packages/shared/src/schemas/person.schemas.ts`'s `questionFrequencySchema`, which uses `"few-days"` (hyphen) — the real API (`apps/api`'s migration 012 check constraint and `collection.routes.ts`'s validation) actually uses `"few_days"` (underscore). My new frontend code matches the real API (underscore), not the shared schema. That mismatch looks like a pre-existing bug worth a look, but fixing a shared-package Zod schema without being able to run the API's test suite felt like the wrong risk to take unsupervised — flagging it here instead.

## Verification

Same constraint as last night: a full `pnpm install` of the mobile app's dependency tree doesn't complete inside this sandbox's per-command time limit. For this pass:

1. All 7 changed/new files passed `esbuild` syntax checks (exit 0, no errors) — valid TS/JSX, no structural mistakes.
2. Manual cross-reference of every hook signature, component prop, and API call against the real source: `usePrivacyTier`/`useVoiceModel`/`ConsentFlowModal` signatures, and every route touched (`GET`/`PATCH /persons/:id/privacy-tier`, `GET`/`PATCH /persons/:id/question-frequency`, `GET /persons/:id/voice-model` + `POST .../preview|consent|pause|revoke`, `GET /family-groups/:id/subscription` + `POST .../takeover`, `GET`/`PATCH /notifications/settings`) — confirmed via `grep` against `apps/api/src/routes/*.ts` to exist with the request/response shape these screens now assume.
3. **Not verified**: a real `tsc` pass against actual React Native/React Router type declarations (same sandbox limitation as last night). Worth running `npx pnpm@9.15.9 --filter @myfamipedia/web exec tsc --noEmit` and `npx pnpm@9.15.9 --filter @myfamipedia/mobile exec tsc --noEmit` locally before or after pulling this, same as the mobile profile screens.

## What to test

Once pulled and typechecked:

* **Web**: log in, go to `/settings/privacy` — change privacy tier and question frequency, confirm both persist (reload the page, values should stick, not reset). `/settings/voice` — "Manage consent" should get through the preview/decision flow without a 403. `/settings/subscription` — status should show without erroring; "Become the paying member" should update the status shown without a manual reload.
* **Mobile**: Account tab → "Voice settings" should navigate somewhere real (not silently fail). Account tab → "Collection settings" should show live privacy tier and question frequency controls, not placeholder text.

## Git — commands for Tim to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia
git status
git add apps/web/src/hooks/useQuestionFrequency.ts apps/web/src/routes/settings/privacy.tsx apps/web/src/routes/settings/voice.tsx apps/web/src/routes/settings/subscription.tsx apps/web/src/routes/settings/notifications.tsx apps/mobile/app/"(tabs)"/account.tsx apps/mobile/app/collection/settings.tsx docs/handover_2026-07-17-settings-fixes.md
git commit -m "Fix hardcoded 'me' id bug in settings screens (privacy/voice/subscription), wire notification toggle, build out mobile collection settings"
git push
```

Note the quoting around `(tabs)` — PowerShell treats parentheses specially, so that segment needs to stay quoted as shown or `git add` will error on it.

No dependency changes, no lockfile step needed.

## Suggested next step

Still open: photos/face-detection (needs R2 + Rekognition credentials from you), search UI (missing on both platforms), mobile's voice consent/settings screens could use the same defensive `= ""` param-default pattern the profile screens use (not broken, just less defensive — low priority). The `few-days`/`few_days` schema mismatch flagged above is worth a deliberate look when you're back at the keyboard, since it's a real inconsistency, just not one I wanted to fix blind.

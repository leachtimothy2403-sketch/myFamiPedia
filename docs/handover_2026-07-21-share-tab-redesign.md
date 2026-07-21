# myFamiPedia — Share tab redesign + text-based tag suggestions (2026-07-21)

Full build of the IA redesign Tim and I talked through: consolidating scattered "add a memory" entry points into a flat Share hub, plus a real answer to "can tagging be auto-detected?"

## 1. Share tab is now a flat 3-button hub, not the interview flow directly

Deliberately flat, not nested sub-tabs — a key user group here is older adults, and a segmented control you have to notice and tap to reveal more options is a worse pattern for that audience than just showing the options as separate, plainly-labeled buttons.

`(tabs)/share-story.tsx` is now the hub: **Share a memory**, **Tell your story**, and **Photos to review** (only shown at all when `GET /collection/proposed` has something waiting — no empty-state clutter). The old interview-only content (whose story is this → open-ended/Q&A/photo-prompted) moved unchanged to `share/tell-your-story.tsx`. Renamed its first option from "Share a memory / talk about your life" to "Open-ended — just start talking" so it's no longer confusable with the hub's own "Share a memory" button — two different things having near-identical names was exactly the kind of overlap this whole redesign was meant to fix.

## 2. New shared compose screen (`share/compose.tsx`) — the actual bug fix

This replaces person profile's old `AddMemoryForm` (an always-open text box hardcoded to whoever's profile you were on, with a placeholder string easy to mistake for typed text — both bugs Tim hit live-testing). One screen now, two doors in: the hub's "Share a memory" button (nobody pre-tagged), or a profile page's "Share a memory about {name}" button (`?personId=` pre-fills the tag). Real people-picker this time — a checkbox list of the family roster, large touch targets, reusing the same cache-shared `["family-tree", familyGroupId]` query every other picker in the app already uses.

## 3. Text-based tag suggestion — answers "can tagging be auto-detected?"

Split this cleanly in two, because the two halves have completely different risk profiles:

**Photo/face-based auto-tagging: not built, on purpose, not something to revisit lightly.** Investigated the face pipeline before touching anything — `apps/api/src/jobs/faceDetection.worker.ts` and `vision.service.ts` both have explicit 2026-07-18 comments confirming real face-matching was deliberately retired: `docs/family_administrator_and_privacy_model.md` section 5 rejects it outright over GDPR Article 9 biometric-data exposure with no legal sign-off, even for a narrower 1:1-verification version. Detection today only ever returns bounding boxes, never an identity. Nothing here revives that.

**Text-based suggestion: built.** Reading text someone typed for family-member name mentions against the known roster isn't biometric processing at all — a completely different, much lower-risk thing. New `claude.service.ts` function `suggestMentionedPersons(content, roster)`: cheap Haiku call, returns only ids actually named in the text (never inferred from context), defensively drops any hallucinated id not really in the roster. New route `POST /memories/suggest-tags`, new `apiClient.suggestMemoryTags()`. Wired into the new compose screen as a "Suggest people" button (deliberately a button, not automatic-as-you-type — predictable beats "magic" for this audience, and it's one Claude call per attempt instead of one per keystroke) that surfaces suggestions as tappable chips. Never auto-applies a tag — the contributor still taps to confirm each one, same "don't force a bad match" principle as `classifyMemoryCategory`'s NONE case.

## 4. Home is now pure consumption

Removed "Review proposed memories," "Add a photo," and "Sync camera roll" buttons from Home — replaced with a plain-worded conditional banner ("N photos need a quick look") that only appears when there's something waiting. The two removed action buttons moved to the top of `collection/review.tsx` instead, alongside the review queue they're related to. "Manage" (browsing memories you already have) stayed on Home — that's a "look at your stuff" action, same category as the feed itself.

**Files:** `apps/mobile/app/(tabs)/share-story.tsx` (rewritten), `apps/mobile/app/share/compose.tsx` (new), `apps/mobile/app/share/tell-your-story.tsx` (new, moved content), `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/(tabs)/_layout.tsx`, `apps/mobile/app/collection/review.tsx`, `apps/mobile/app/person/[id]/index.tsx`, `apps/mobile/app/_layout.tsx`, `apps/mobile/app/interview/new.tsx` + `interview/[personId]/new.tsx` (stale dead-redirect targets corrected), `apps/api/src/services/claude.service.ts`, `apps/api/src/routes/memories.routes.ts`, `packages/shared/src/apiClient.ts`, `apps/api/tests/routes/memories.test.ts` (4 new tests for `POST /memories/suggest-tags`).

**Not yet done:** apps/web has no equivalent of this redesign — untouched, mobile-only for now. No mobile test suite exists in this repo (confirmed before starting — nothing to update), so this hasn't been exercised beyond esbuild syntax-parsing every touched file. Worth a real run-through on a device before considering this done. `pnpm test` from `apps/api` covers the new backend route.

## Git — commands to run (PowerShell)

```powershell
cd C:\Users\leach\myfamipedia

git add apps/api/src/services/claude.service.ts apps/api/src/routes/memories.routes.ts packages/shared/src/apiClient.ts apps/api/tests/routes/memories.test.ts
git commit -m "Add text-based memory tag suggestions (POST /memories/suggest-tags)

Answers 'can tagging be auto-detected' - split in two on purpose.
Photo/face-based auto-tagging is NOT built: investigated the face
pipeline first, found real face-matching was deliberately retired
2026-07-18 (docs/family_administrator_and_privacy_model.md section 5 -
GDPR Article 9 biometric-data exposure, no legal sign-off). Detection
only ever returns bounding boxes now, never an identity - nothing here
revives that.

Text-based suggestion is a completely different, much lower-risk
thing: reading typed text for family-member name mentions against the
roster isn't biometric processing at all. New
suggestMentionedPersons(content, roster) in claude.service.ts - cheap
Haiku call, only returns ids actually named in the text, defensively
drops any hallucinated id not really in the roster. Suggestions only,
never auto-applied - the new compose screen shows these as tappable
chips the contributor still has to confirm.

4 new tests: happy path, NONE response, hallucinated-id dropped,
missing content 400."

git add apps/mobile/app/(tabs)/share-story.tsx apps/mobile/app/share/compose.tsx apps/mobile/app/share/tell-your-story.tsx apps/mobile/app/(tabs)/index.tsx apps/mobile/app/(tabs)/_layout.tsx apps/mobile/app/collection/review.tsx apps/mobile/app/person/[id]/index.tsx apps/mobile/app/_layout.tsx apps/mobile/app/interview/new.tsx "apps/mobile/app/interview/[personId]/new.tsx"
git commit -m "Redesign Share tab into a flat hub, fix profile tagging bug

Consolidates scattered add-memory entry points (the interview flow,
a profile page's always-open text box, Home's review/add-photo/sync
buttons) into one place, per live-testing feedback. Deliberately flat
- three big labeled buttons, not nested sub-tabs - since a control you
have to notice and tap to reveal more options is a worse pattern for
an older-adult user base than just showing the options.

(tabs)/share-story.tsx is now the hub (Share a memory / Tell your
story / Photos to review, the last one only shown when something's
actually waiting); the old interview-only content moved unchanged to
share/tell-your-story.tsx. New share/compose.tsx replaces person
profile's old AddMemoryForm, which had two real bugs: hardcoded to
whoever's profile you were on with no way to tag anyone else, and a
placeholder string easy to mistake for typed text (both hit live-
testing, one produced a confusing 'Write something first' error on an
apparently non-empty field). One shared screen now, two doors in: the
hub, or a profile's 'Share a memory about {name}' button pre-tagging
that person.

Home is now pure consumption - removed its three add/review buttons
(moved to the hub and collection/review.tsx), added a plain-worded
conditional banner for pending reviews instead of an always-present
button.

Also corrected two dead-redirect stub screens (interview/new.tsx,
interview/[personId]/new.tsx) that pointed at the old share-story.tsx
interview flow, which moved to share/tell-your-story.tsx."
```

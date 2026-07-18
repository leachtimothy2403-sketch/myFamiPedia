# myFamiPedia — Handover (2026-07-18, bug-fix + admin/privacy design session)

This session had two distinct halves: a normal bug-fix pass early on (real code, tested, ready to commit), followed by a multi-hour product design conversation with Tim that produced no code at all — decisions only, now written up in `docs/family_administrator_and_privacy_model.md`. Read that doc for the actual content; this handover is about what happened and what to do next, not a restatement.

## Part A — bug fixes (code, done, needs committing)

Three real bugs, found and fixed via live testing on-device:

1. **Q&A recordings showing in the person-profile Memories Feed.** Recorded interview answers (`provenance_type = 'voice'`) were mixed in with memories someone actually chose to enter. Fixed with a `?excludeVoice=true` param on `GET /persons/:id/memories`, used by both profile screens; left the default unfiltered since `collection/manage.tsx` still needs voice memories listed to retract them.
2. **Home tab's family feed was fetching `/notifications` and discarding every row** (`renderItem={() => null}`) — always looked empty regardless of what the family had added. Added a real `GET /family-groups/:id/memories` endpoint and wired the Home screen to it.
3. **A memory written on someone else's profile also showed up on the contributor's own profile.** `GET /persons/:id/memories` and `/timeline` matched on `contributor_id OR memory_persons.person_id`, conflating "wrote it" with "about them." Fixed to key off `memory_persons` tagging (see `belongsToProfile` in `persons.routes.ts`), with a narrow fallback for genuinely untagged memories. This changed what `collection/manage.tsx`'s "Your memories" screen needed too — added `?asContributor=true` so that screen still finds things you contributed regardless of who they're tagged to, since retract/delete rights are a contributor thing, not a subject thing.

**Files changed:** `apps/api/src/routes/persons.routes.ts`, `apps/api/tests/routes/persons.test.ts` (new tests for all three), `apps/mobile/app/person/[id]/index.tsx`, `apps/web/src/routes/person/[id]/index.tsx`, `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/collection/manage.tsx`.

**Verification:** all four TS/TSX files and the test file syntax-checked clean via the sandbox's `esbuild` (same constraint as every other handover this repo has — `pnpm install`/real `tsc` won't finish inside this sandbox's per-command time limit). Recommend running `pnpm --filter @myfamipedia/api exec vitest run tests/routes/persons.test.ts` locally before pushing, since that's real logic (RLS-context queries, tenant scoping on the new family-feed endpoint) that deserves an actual test run, not just a syntax check.

## Part B — admin role & privacy model (design only, no code)

Tim brought back feedback from the original product-design chat: the family administrator role was a real, detailed concept that never made it into `docs/` or the build. Rather than guess at scope, this turned into a long back-and-forth working through it properly — and it kept expanding, because pulling on "who can add a family member" led directly into "who can post about someone else," which led into the camera-roll auto-tagging design, which surfaced a real GDPR/CNIL exposure in the facial-recognition pipeline that hadn't been considered, which reshaped the privacy-tier system once automated recognition got ruled out for the beta.

Full writeup: **`docs/family_administrator_and_privacy_model.md`**. Everything below is a summary; that doc has the reasoning, the cross-references to `data_model.md`/`invitation_flow.md`/`media_pipeline.md`/`section2_pipeline.md`, and the exact schema/implementation notes.

Decided:
- A family-group-level administrator role exists, is separate from `paying_member_id` (billing) and from the existing per-deceased-profile `administrator_person_id`, and should live as a plain column on `persons` rather than a new membership table.
- It gates three things: manually adding a living family member, approving a photo-tag-triggered new person (via a proposal queue, not direct creation), and starting a deceased profile. It does not gate `privacy_tier` or tagging an existing person.
- Tagging permission itself stays open to any family member — the actual fix needed is UI framing/attribution, not a permission restriction (section 8 of the design doc).
- A trust list, self-governed per person (never admin-overridable), controls who can tag you without a review delay.
- Pending (`invited_pending`) profiles stay visible as a named node in the tree, but their content stays hidden until acceptance — this already half-works via `holding_space` for photo-tagged content, but manually-typed memories currently bypass it entirely. Real bug, not yet fixed, on the list below.
- **No automated facial recognition/matching for the beta**, full stop — detection (face regions) plus 100%-manual human tagging only. This is a real GDPR Article 9 exposure (processing bystanders' biometric data without a lawful basis, worse in France given CNIL's enforcement history), not something either of us could responsibly resolve without a lawyer, so the beta is scoped to avoid needing one yet.
- What replaces the automatic-tagging "magic": non-biometric content/scene classification (what kind of moment is this — cake, milestone, beach — not who's in it) and non-biometric time/location photo clustering (group by EXIF timestamp + GPS proximity into likely "outings"), both approved for the beta. Crowdsourced tag completion (anyone can add a tag for a still-unidentified person, not edit existing tags) also approved.
- The original 3-tier privacy system doesn't survive automated recognition being off the table — tier 1 assumed a match telling the system whose queue to route into. Redefined and reduced to 2 tiers governing what happens *after* a human tags someone (review window vs. requires explicit action), not whether AI can auto-tag them.

## Suggested next steps, roughly in priority order

1. **Commit and ship Part A.** It's done, tested to the extent this sandbox allows, and unrelated to everything in Part B — no reason to hold it up.
2. **Build the administrator role first**, before anything else in the design doc, since almost everything else (the three gated actions, the trust-list defaults for pending profiles, the tier redefinition) assumes it exists. Section 1 of the design doc has the concrete schema shape.
3. **Fix the pending-profile content gap** (section 3) — it's a real, already-observed bug (Juliette's profile), small in scope, and independent of the admin role work.
4. **UI framing fix** (section 8) — small, independent, high-visibility. The backend half of this (correct contributor attribution) already shipped in Part A; this is just the copy/display layer on top.
5. **The beta photo pipeline** (sections 5-7 of the design doc) is the biggest remaining piece — detection-only tagging, crowd-mode threshold, content classification, time/location clustering, both suggestion entry points. Worth its own dedicated planning pass rather than folding into the admin-role work, since it touches the mobile camera-roll sync flow, R2/Rekognition-adjacent infrastructure (detection only, no matching), and two new non-biometric ML pieces that don't exist yet.
6. **Do not build any automated face-matching/recognition** until real legal counsel with CNIL/GDPR experience has actually reviewed it — this was explicit and shouldn't get quietly reopened by a future session that hasn't seen this conversation. The design doc's section 5 has the specific architectural directions (on-device processing, verification-vs-identification) worth bringing to that conversation when it happens.
7. Two small unresolved details when the tier work starts: exact wording/naming for the two privacy tiers, and the crowd-mode face-count threshold — both flagged as open in the design doc, neither blocking.

## Git — commands for Tim to run (PowerShell, not this sandbox)

Same standing rule as every prior handover: git runs locally, not from this sandbox, and there's a history of a stale `.git/index.lock` needing clearing first.

```powershell
cd C:\Users\leach\myfamipedia
git status
Remove-Item .git\index.lock -ErrorAction SilentlyContinue
git add apps/api/src/routes/persons.routes.ts apps/api/tests/routes/persons.test.ts apps/mobile/app/person/"[id]"/index.tsx "apps/mobile/app/(tabs)/index.tsx" apps/web/src/routes/person/"[id]"/index.tsx apps/mobile/app/collection/manage.tsx docs/family_administrator_and_privacy_model.md docs/handover_2026-07-18-admin-role-privacy-design.md
git commit -m "Fix memory attribution bugs (Q&A in feed, missing family feed, wrong-profile memories); write up family administrator role and privacy model design"
git push
```

Same quoting note as always — `[id]` and `(tabs)` need the quotes shown or PowerShell errors on `git add`.

## Where things stand

Part A closes out three real, user-reported bugs, tested and ready. Part B is a full design pass on something that was genuinely missing — not just the administrator role itself, but a real compliance issue in the planned camera-roll feature that hadn't been caught yet. Nothing in Part B is built. The next session's real choice is whether to start on the administrator role (item 2 above) or the beta photo pipeline (item 5) first — both are substantial, and the design doc has enough detail on each to start either without Tim needing to re-explain any of this from scratch.

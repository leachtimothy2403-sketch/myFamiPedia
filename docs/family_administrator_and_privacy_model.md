# myFamiPedia — Family Administrator Role & Privacy Model

Reconstructed 2026-07-18, from a design conversation between Tim and Claude that traced the family-administrator concept back to the original product-design chat, where it existed in detail but never made it into `docs/` or the build. See `docs/handover_2026-07-18-admin-role-privacy-design.md` for the session this came out of. Nothing in this document is implemented yet — it's decisions, not code. Treat this as the source of truth for the *next* implementation pass, and update it as those decisions land or change.

This intentionally sits alongside, and in a few places corrects, `docs/data_model.md`, `docs/invitation_flow.md`, and `docs/section2_pipeline.md` rather than replacing them. Cross-references below point at what each decision touches.

## 1. The family administrator role

A family-group-level role, separate from two things it's easy to confuse it with:

- **Not `paying_member_id`** (`family_groups` table). That's a billing relationship. The administrator is a trust/governance role. They're very often the same person — usually whoever started the family group — but nothing should force that, and nothing should derive administrator status from who's paying.
- **Not `persons.administrator_person_id`.** That's a real, already-implemented concept, but it's scoped to a single deceased profile — whoever creates that profile becomes its curator, for that profile's `collecting`/`complete` state only. The family-group administrator is a broader, group-wide role that this document introduces on top of it.

**Default:** whoever creates a family group becomes its administrator. Transfer/succession (e.g. a backup administrator for redundancy) was discussed and explicitly parked — not in scope for the initial build. Ship with exactly one administrator per family group, transferable by the current one.

**What it gates** (see section 2 for why these three specifically):
- Manually adding a new living family member from the tree.
- Approving a brand-new person being created via an unrecognized-face photo tag.
- Initiating a deceased profile (`POST /persons/deceased`).

**What it explicitly does NOT gate:**
- `privacy_tier` — stays strictly self-write, matching the existing hardened RLS policy (the deletion-trigger comment already says "even a future buggy admin tool can't slip past it" — that instinct was correct and should not be revisited for this role).
- Tagging an *existing* person in a memory — stays open to any family member. See section 4.
- The trust list (section 4) — self-governed for active adults, no admin override, ever.

**Where it should live technically:** a plain column on `persons` (e.g. `family_role`), not a separate membership table. `persons.family_group_id` is already a single required foreign key — one person belongs to exactly one family group, no many-to-many anywhere in the schema — so a column is the simplest thing that fits the existing pattern (`privacy_tier` and `administrator_person_id` are both already plain columns on this table). A membership table only earns its complexity if a person could ever belong to more than one family group, which nothing in the current design anticipates. If that assumption ever changes, this is a bigger migration regardless of what's chosen now.

**Supporting evidence this was actually designed, not invented today:** `apps/api/src/middleware/auth.ts`'s `markAsAdministratorAction` already carries this comment, written well before this conversation: *"Route handlers still must check the caller actually holds the administrator role for the target person/family."* Family-level, explicitly, sitting right next to the only administrator check that's actually implemented (the per-deceased-profile one). That's the seam to build against.

## 2. Adding people to the tree — the "consequential act" principle

Creating a new node in the family graph is a consequential act — it starts a 90-day invitation clock, sends a real notification to a real person, and creates a permanent record. Today, three different triggers all produce that same outcome:

1. Manually tapping "add family member" on the tree screen.
2. Tagging an unrecognized face in a photo with a name that doesn't match an existing profile (`docs/media_pipeline.md` step 5 / `docs/invitation_flow.md`'s "Trigger" section).
3. `POST /persons/deceased`.

In the actual code, (1) and (2) already collapse into the same handler — `invitations.routes.ts`'s `POST /invitations` branches only on whether `triggeringPhotoId` is set. That matters: gating only the UI button for (1) while leaving (2) open would just relocate the "a distant cousin unilaterally adds someone" problem to the photo-tagging screen, not fix it.

**Decision, per path:**

- **(1) Manual add-from-tree:** administrator-only. The button is not shown at all to non-admins — no partial/"request" flow, it simply isn't there.
- **(3) Deceased profile creation:** administrator-only, confirmed directly — matches the recovered original design ("only the administrator can initiate a deceased person's profile").
- **(2) Photo-tag-triggered:** different shape, because unlike (1) and (3), *recognizing* a face is exactly the thing you want any family member to be able to do — an admin isn't necessarily the one who'll recognize a cousin's college roommate in an old photo. So this isn't gated by blocking who can type a new name; it's gated by turning the tag into a **proposal** rather than an immediate creation. Someone tags an unrecognized face "Aunt Sophie" — nothing gets written to `persons`/`invitations` yet. It goes into an admin approval queue (same two-tap accept/reject shape as the existing `proposed_memories` review card), and only on approval does today's `POST /invitations` logic actually fire. `invited_by_person_id` on the resulting invitation should be the *original tagger* (they're the one vouching for the identification), not the approving admin.

This also directly interacts with section 6 (no facial recognition for the beta) — since there's no automated matching happening at all in the beta, this whole "unrecognized face" path only ever gets reached through manual tap-to-tag (section 7), not an automatic review card. The proposal-to-admin step still applies whenever that manual tagging results in a brand-new person.

## 3. Pending-profile visibility

Decided: **the node stays visible, the content doesn't.**

A person who's been invited but hasn't accepted (`status = 'invited_pending'`) still shows up in the tree with their name and an "Invitation pending" badge, fully tappable. Reasoning: this lets the family see an invitation is already in flight and avoids duplicate invitations for the same person — full invisibility would mean nobody else could tell "Aunt Sophie" was already being invited, and might independently create a second, duplicate pending profile for her.

What must NOT show, until they accept: any content. This already works correctly for photo-tagged content — it routes into `holding_space`, which has an RLS policy (`holding_space_owner_only`) restricting it to the original contributor only, drained into the real tables in one batch on acceptance (`docs/media_pipeline.md` section 3).

**Bug identified, not yet fixed:** manually-typed memories (the ordinary "share a memory" flow, `POST /memories`) have no equivalent gate. They write straight to `memories`/`memory_persons` today and show live on a still-pending profile immediately — this is exactly what happened with Juliette's profile during this session (a memory posted and visible in her timeline despite her invitation being pending). Fix: extend the same holding treatment photo-tags already get to text memories tagging a not-yet-active person.

**Useful implementation detail:** `holding_space.media_type` already has a `'mention'` value (`CHECK (media_type IN ('photo','mention','voice'))`) that nothing in the current code uses. This is almost certainly the seam this fix was meant to use — stage the tag/content there with `media_type = 'mention'` instead of writing directly to `memories`, and drain it the same way photos already drain.

**Per-tag, not per-memory:** if a memory tags both an already-active person and a still-pending one (e.g. "boat trip with Marc and Aunt Sophie," Marc active, Sophie pending), the memory should show normally for Marc immediately — only Sophie's specific tag is what's held back. Don't hold the whole memory hostage to the slowest person tagged in it.

## 4. Consent for tagging living adults — the trust list

**Permission stays open:** any family member can tag any other living relative in a memory they write. This was confirmed as intentional, not a bug — restricting *who can tag* was explicitly rejected in favor of fixing *attribution and visibility default* instead.

**The actual problem this replaces:** opening someone else's profile and writing directly onto it (e.g. "went on a boat trip," written from Marc's profile) reads as if Marc said it himself. See section 8 for the UI fix. The permission model itself doesn't need to change — the framing does.

**Default visibility for a tag from someone not specifically trusted:** shows immediately in the contributor's own feed and the general family feed, but doesn't land on the tagged person's own profile until either they clear it or a review window elapses. (This folds into the privacy-tier redefinition in section 6 — the review-window behavior *is* what one of the two remaining tiers now means.)

**Trust list:** a per-person, explicit list of people exempt from that review window — their tags show immediately, no hold. Governance:

- **Active adult:** strictly self-governed. Nobody — not the family administrator, nobody — can add or remove someone from your trust list on your behalf. Same pattern already enforced for `privacy_tier` and voice consent (self-write-only RLS policy).
- **Not-yet-active profile** (pending invitation, or effectively-a-minor with no account of their own): whoever added them to the tree is trusted by default — same shape as the deceased-profile `administrator_person_id` pattern, just for the "can't consent for themselves yet" case instead of "can't consent, ever." This trust transfers to the person themselves once they activate their own account, at which point it's revocable like anyone else's.

## 5. Camera-roll facial recognition — the GDPR/CNIL decision

**Core finding:** running automated face-matching against everyone detected in a photo — including non-family bystanders who never consented to anything, e.g. strangers in a crowd photo — is very likely GDPR Article 9 special-category biometric processing requiring a lawful basis a bystander hasn't given. Not storing their data afterward reduces risk but likely doesn't remove the requirement for a basis to run the comparison in the first place; Article 9's "processing" is broad enough to plausibly cover the comparison step itself, not just retention.

**The "it's just personal use" argument doesn't hold up for the company.** GDPR Recital 18's household/personal exemption explicitly does not extend to a controller or processor that *provides the means* for otherwise-personal processing. myFamiPedia (the company operating the Rekognition/Vision infrastructure) doesn't inherit an individual user's personal-use exemption just because the end use feels personal to them.

**France specifically raises the stakes**, not lowers them: CNIL is one of the more active enforcers on exactly this — the Clearview AI case (€20M fine, ordered to stop and delete) was for unlawful facial-recognition processing without a valid basis.

**Real precedent exists that this isn't categorically forbidden** — Facebook relaunched facial recognition in the EU in 2018 as an explicit, separate opt-in, distinct from general terms-of-service consent — but even that relaunch left an open regulatory question (Irish DPC) about whether scanning *everyone's* face, including non-users, to attempt matches was itself justified. That's the unresolved piece directly relevant to a crowd photo, and it doesn't have a clean answer in the precedent that exists. Google, with far more legal resources, currently ships face grouping *disabled by default* across the EU rather than solve it.

**Decision for the beta: no automated facial recognition/matching at all.** The flow is:

1. A photo is taken/synced. Faces are *detected* only — bounding boxes, not identity. Detection isn't biometric identification data; it's geometry, no Article 9 exposure for anyone, family or stranger.
2. The user reviews the photo. Detected face regions are shown as tap targets.
3. The user taps the faces of people they recognize and assigns a name from a list. Zero algorithmic comparison happens anywhere in this step — the human is doing 100% of the identification, the app is only recording an asserted fact.

This is the whole reason the automated review-card flow described in `docs/media_pipeline.md` step 3-4 and `docs/section2_pipeline.md`'s tier-1/tier-2 auto-submit branching does not apply for the beta — see section 6 for what replaces it.

**Explicitly deferred, needs real legal counsel before it ships (beta or otherwise):** any actual automated matching. Two architectural directions were identified as worth bringing to counsel rather than the current Rekognition/Vision cloud-API design: on-device processing (materially different risk profile — no cross-border transfer, no centralized breach target, closer to Apple's own on-device Photos face-grouping, though this does *not* obviously resolve the controller question since myFamiPedia would still be determining purpose/means even if computation runs locally), and a narrower "verification, not identification" pattern for an *already-enrolled, already-consented* person only (1:1 confirmation of a human-asserted tag against that one person's own template, rather than 1:many search against the whole collection) — meaningfully lower risk since it never touches a non-enrolled stranger's data by construction, but still needs counsel to confirm before relying on it.

**Explicitly considered and rejected:** a small, separately-consented internal test of the fuller matching-assisted UX on staged photos with willing beta testers. Not pursued.

## 6. Crowd photos

When a photo has an unusually high number of detected faces (tunable threshold — not yet picked, needs a number), suppress the automatic "who is this?" prompting for unmatched faces entirely. Don't ask about all 20 people in a crowd shot. Below the threshold — a normal photo with one or two unrecognized faces — the prompting behavior is unaffected.

Detected face regions stay available as tap targets on the photo regardless of crowd-mode status, so identifying someone in a crowd is still possible — it's a pull action a family member can take if they recognize someone, not a push prompt from the system.

## 7. What replaces automatic recognition-based memory creation

Since tagging people now always requires a human, the original tier-1 concept (`docs/section2_pipeline.md`'s "collect everything, auto-submit — no review step") is not achievable and is retired. It depended on a match telling the system whose review queue to route into; without recognition, the system doesn't know who a candidate photo is about until a human tags it, so there's no longer a moment where a *per-subject* tier setting has anything to attach to for photo-sourced content.

**`privacy_tier` is redefined, and reduced from three values to two.** It no longer governs whether the system is allowed to auto-tag someone (impossible now) — it governs what happens *after* a human has tagged them, which is the one point in the pipeline where the system actually knows who it's talking about:

- **Tier 1:** a short review window before the tag becomes visible on their profile (this is the same mechanism as the trust-list default hold from section 4 — a subject not on the tagger's trust list gets this review window regardless of which tier they've picked; tier interacts with, but doesn't replace, the trust list).
- **Tier 2:** requires the subject's own explicit action — no auto-expiring window, nothing appears without them confirming it themselves.

A third "shows immediately, zero review" option was considered and dropped — not because it's unsafe in principle, but because it's redundant: the trust list already delivers that exact outcome, per-person, for people you actually trust, which is a more precise mechanism than a blanket "everyone's tags of me are instant" setting would ever be. **Exact wording and the review-window duration are still open — not decided.**

**Not yet built, and not the same thing as migration 025.** This redefinition (repurposing `privacy_tier`'s remaining values for the trust-list tag-review window described above) hasn't been implemented — it depends on the trust-list feature itself, which was discussed and deliberately tabled on 2026-07-18 (see `docs/photo_pipeline_beta_architecture.md`'s open items). Separately, that same day, `privacy_tier`'s dead value `1` was retired at the DB/API level (migration 025) since it had no live behavior left once automated matching was disabled — that was a narrow cleanup of a selectable-but-inert value, not this redefinition. Tiers 2 and 3 today still mean exactly what `docs/section2_pipeline.md` section 2/3 describe (review-card cadence, manual-tier nudge) — nothing here has shipped yet.

**"Smart" automatic suggestion is preserved through two non-biometric mechanisms** instead of face recognition — both approved for the beta:

- **Content/scene classification.** Recognizing *what kind of moment* a photo depicts — a cake and candles, a visible gap in a child's teeth, a beach — from ordinary visual content, without identifying *who* is in it. This is not biometric data; it's the same category of technology as photo-library content search (e.g. searching "beach" in a photo library), which is unrestricted in the EU even where face grouping is not. Used to pre-fill a caption suggestion the user can accept or edit, or to help decide whether a photo is worth surfacing as a candidate at all. Works well for visually distinctive events (birthdays, weddings, milestones with a clear visual signature); doesn't work for personally-significant-but-visually-ordinary moments ("last day of vacation") — those still need the plain "what's this about?" fallback.
- **Non-biometric time/location clustering.** Grouping photos purely by EXIF timestamp and GPS proximity — no image content analysis at all. A burst of photos taken close together in time, at a location distinct from the user's usual pattern, gets treated as one likely "outing" and bundled into a single candidate-memory suggestion (via the existing `memory_photos` many-to-many, built for exactly this — "one story, several photos") rather than one prompt per photo. Cheaper and more conservative than content classification since it never interprets pixels at all, purely arithmetic on metadata every photo already carries.

**The photo-to-memory flow is one flow, two entry points**, not two separate systems: photo → detect faces → human taps to tag → human fills in what/where/when. The two triggers into that same flow — the app proactively suggests a candidate (via clustering and/or classification), or the user picks their own photo and starts the flow themselves — are both in scope for the beta.

**Crowdsourced tag completion:** any family member, not just the original contributor, can add a tag for a person who hasn't yet been identified in an existing memory or photo — closing gaps the original poster couldn't fill (they might not recognize everyone; someone else might). Scoped to *adding* tags for not-yet-identified people only — not editing or removing tags the original contributor already made.

## 8. UI framing when contributing on someone else's profile

Decided, not yet built. Two changes:

- Compose-screen copy changes to something like "Share your memory of [Name]" rather than the current generic "Share a memory…" placeholder, when the form is launched from someone else's profile rather than your own.
- The resulting memory card must lead with contributor attribution — "Tim remembers: went on a boat trip" rather than a bare, unattributed sentence that reads as if the subject wrote it themselves. Primary information, not a footnote.

Note: the *backend* half of this was already fixed this session (see the handover) — `contributor_id` is confirmed always server-derived from the auth token, never client-supplied, and the profile/timeline queries now correctly key off who a memory is tagged to rather than who wrote it. This section is the remaining UI/copy work on top of that.

## Open items — not yet decided

- Exact wording and review-window duration for the two privacy tiers in section 7.
- Crowd-mode face-count threshold (section 6) — a number hasn't been picked.
- Long-term, post-beta facial recognition strategy — intentionally still open, pending real legal/CNIL-experienced counsel. Nothing in this document should be read as clearing automated matching for a post-beta release.

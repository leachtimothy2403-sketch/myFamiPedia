# myFamiPedia — Section 2 Automatic Collection Pipeline

Builds on the media pipeline (photo/face detection) and voice pipeline (transcription) docs. This one covers the product-facing scheduling, privacy-tier branching, and the question stream.

## 1. Camera roll stream — privacy tier branching

**2026-07-18 rewrite.** This section originally described `persons.privacy_tier` branching whether a face-*match* auto-submitted to `memories`, went to `proposed_memories` for review, or was discarded. That behavior is gone along with automated matching itself (`docs/media_pipeline.md`, `docs/photo_pipeline_beta_architecture.md`) — there's no more "a match came back" moment for a tier to branch on.

What actually produces a `proposed_memories` row today is the two-stage scene classification pipeline and the time/location clustering job (architecture doc sections 5-6), and **neither currently reads `privacy_tier` at all.** Every candidate they surface goes to `proposed_memories` and into the person's review-card queue, regardless of tier. In practice this means:

- **Tier 2** still does something real and unchanged: `sweepReviewCardCadence` (`scheduledJobs.worker.ts`) notifies tier-2 people once they have ≥3 pending `proposed_memories` — that part of the pipeline never depended on *how* the candidate was produced, only on the pending count, so it kept working correctly through the matching→classification swap without any code change.
- **Tier 3** still does something real and unchanged too: `sweepManualTierNudges` nudges tier-3 people who haven't manually added anything in 14-21 days — again independent of how candidates get created.
- **Tier 1** currently has no distinct live behavior left. It used to mean "skip review entirely, auto-submit" — that's not possible anymore since nothing auto-submits without a human tap. Selecting tier 1 today is indistinguishable in practice from not being tier 2 or tier 3. This is an honest inconsistency, not a design decision — `docs/family_administrator_and_privacy_model.md` section 7 has a proposed redefinition (two tiers instead of three, governing the trust-list tag-review window rather than photo auto-submission) but that redefinition isn't built yet, and the API still validates `privacyTier` as `1 | 2 | 3` (`collection.routes.ts`). Worth resolving — either build the redefinition or explicitly retire tier 1 — rather than leaving a selectable setting that does nothing.

## 2. Review card cadence

- `Q_CRON` runs a daily batch: for each tier-2 person with ≥3 pending `proposed_memories`, enqueue a notification ("You have N new memories to review"). Weekly is the target cadence but the batch itself runs daily and applies per-person throttling (`last_review_notification_at`) so a burst of uploads doesn't spam.
- Review card UI pulls `GET /collection/proposed`, groups into batches of 3, each resolved via `accept`/`reject` (two-tap target — no intermediate confirmation screens).
- Rejected proposals are soft-deleted (`status='rejected'`), retained for the AI-adaptation loop in section 4 below, not shown again.

## 3. Manual-tier nudge

`Q_CRON` daily job checks tier-3 persons for `last_manual_add_at` > 14–21 days (randomized in that band to avoid a mechanical feel) → fires the "gentle nudge" notification, opt-in only (`notification_settings` default `off` for this type per doc section 8). Copy is warm/low-pressure by design — this is a content/product constraint, not a technical one, but the trigger condition itself excludes anyone who has notifications disabled or who added something manually inside the window, so it never fires on someone actively engaged.

## 4. Question stream

- `persons.question_frequency` ∈ `never | few_days | weekly (default) | daily`.
- `Q_CRON` evaluates due prompts daily: for each active person with frequency ≠ `never`, if `now() - last_prompt_sent_at >= frequency_interval`, select next question (Claude-generated, personalized against existing `memories`/`profile_data` to avoid repeats) and push via `Q_NOTIF`.
- **Adaptive frequency**: a lightweight engagement score per person (rolling: prompts_sent vs. prompts_answered over trailing 30 days) is recomputed after each response cycle. If answer rate drops below a threshold (e.g. <30%), the effective interval is stretched (e.g. weekly → effectively bi-weekly) without changing the user's stored `question_frequency` setting — the setting is the ceiling the user chose, the adaptive layer only ever backs off, never increases beyond what the user selected. This keeps the "AI adapts frequency dynamically based on engagement" behavior from silently overriding user preference in the other direction.
- Answers (`POST /question-prompt/:id/answer`) follow the same path as any voice/text memory: voice answers go through `Q_TRANS`; both land in `memories` with `provenance_type` set accordingly.

## 5. Notification dedup

All Section 2 notifications route through `Q_NOTIF`, which checks `notification_settings` per user/type before dispatch and coalesces same-type notifications generated within a short window (e.g. review-ready + question-prompt on the same day merge into a single push) to avoid multiple pings in one day.

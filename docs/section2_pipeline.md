# myFamiPedia — Section 2 Automatic Collection Pipeline

Builds on the media pipeline (photo/face detection) and voice pipeline (transcription) docs. This one covers the product-facing scheduling, privacy-tier branching, and the question stream.

## 1. Camera roll stream — privacy tier branching

After `Q_FACE` produces a match (see media pipeline doc), routing depends on `persons.privacy_tier` for the **profile owner being matched**, not the uploader:

| Tier | Behavior |
|---|---|
| 1 — collect everything, auto-submit | Match writes directly to `memories` (provenance `photo`), no review step. |
| 2 — collect, review before submit | Match writes to `proposed_memories` (`status='pending'`). Surfaces in the weekly/daily review card. |
| 3 — manual only | Match is discarded from auto-pipeline entirely (or held ephemerally for 24h in case tier changes); user must manually add via the standard "add memory" flow. |

This branch is evaluated in the `Q_FACE` worker itself (reads `persons.privacy_tier` before deciding whether to write `memories` vs `proposed_memories` vs nothing), not deferred to the API layer — keeps the rule enforced in one place regardless of which client calls it.

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

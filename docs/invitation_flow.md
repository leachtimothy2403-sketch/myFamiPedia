# myFamiPedia — Invitation Flow (Technical)

State machine for the five-state person lifecycle (`persons.status`), driven by the `invitations` table.

## States & transitions

```
                 ┌────────────────────────────────────────────┐
                 │                                              │
                 ▼                                              │
[no row] ──create──> invited_pending ──decline──> declined_grace │
                 │         ▲                    │      │        │
                 │         │  reinvite (x1)      │      │        │
                 │         └─────────────────────┘      │        │
                 │                                       │        │
              accept                              accept(<=90d) │
                 │                                       │        │
                 ▼                                       ▼        │
              active <───────────────────────────────────┘        │
                                                                    │
declined_grace ──90 days elapse, no action──> opted_out (expired) ─┘
[any state] ──explicit permanent opt-out request──> opted_out
```

## Trigger: naming someone in a photo/memory

`POST /invitations` is never called directly by a client action labeled "invite" — it's a side effect of tagging. Whenever a face-tag or @mention names a person who doesn't yet have an `active` `persons` row:
1. Create `persons` row, `status='invited_pending'`.
2. Create `invitations` row: `token` (opaque, random, URL-safe), `invited_by_person_id`, `triggering_photo_id` set to the photo that caused the tag.
3. Send invite (push if the named person is somehow already reachable via phone/email on file, otherwise the inviter shares the link manually — MVP assumption, no contact-lookup service).
4. Photo (and any other data specifically about them) routes to `holding_space`, unprocessed — see media pipeline doc.

This is intentionally never silent: there is no code path that creates an `active` or populated profile without going through this invitation row.

## Accept

`POST /invitations/:token/accept` (public route, token-authenticated, no login required to view — login/account creation happens as part of accept if they don't already have a `users` row):
1. `invitations.status = 'accepted'`.
2. `persons.status = 'active'`, `persons.user_id` linked (new or existing `users` row).
3. Enqueue `holding-space-drain` job (media pipeline doc, section 3) — processes everything accumulated at once.
4. If this acceptance came from `declined_grace` (i.e., within the 90-day window after an earlier decline), same drain path runs — "accepted after decline" isn't a separate technical state, it's `declined_grace → active` via the same accept endpoint, just arriving later.

## Decline

`POST /invitations/:token/decline`:
1. `invitations.status = 'declined'`, `decline_at = now()`.
2. `persons.status = 'declined_grace'`, `grace_period_end = now() + interval '90 days'`.
3. `holding_space` rows frozen (no writes except new incoming tags, which simply queue up — no processing regardless).
4. The countdown (`grace_period_end`) is exposed only via a query filtered to `invited_by_person_id = requesting_person_id` — it is the inviter's private information, never broadcast family-wide. Enforced by the RLS policy on `invitations` described in the privacy-enforcement doc, not just by the endpoint.

## Re-invite (one allowed)

`POST /invitations/:id/reinvite`, callable only by `invited_by_person_id`, only while `status='declined'` and `reinvited=false`:
1. New `invitations` row created (fresh `token`), `reinvited` on the **original** row flipped to `true` so a second re-invite attempt is rejected at the DB/API layer.
2. **Assumption flagged for review:** the doc doesn't specify whether a re-invite resets the 90-day clock. This design keeps `grace_period_end` anchored to the *original* decline (no reset) — a re-invite is a nudge, not a new grace period. If you want the clock to reset on re-invite, that's a one-line change (recompute `grace_period_end = now() + 90d` on the new row and carry it back to `persons`). Flagging this because it's a product call, not purely technical.

## Expiry (90 days, no action)

`Q_CRON` daily sweep: `SELECT * FROM invitations WHERE status='declined' AND grace_period_end < now()`:
1. `persons.status = 'opted_out'` (expired variant — same terminal state as explicit opt-out, distinguished only by an internal `opt_out_reason` column if you want to report on it separately).
2. `holding_space` rows for that person deleted (DB rows + R2 objects per lifecycle rule).
3. `photo_persons` tags referencing them removed; underlying `photos` rows untouched (they remain the inviter's own memories).
4. Face permanently excluded from the family's Rekognition collection (was never added anyway, so this is a no-op guarantee rather than an active removal).

## Explicit permanent opt-out

`POST /persons/:id/opt-out`, callable by the person themselves at any state (including from `active`, i.e., someone can leave and forbid re-invitation even after having joined):
1. `persons.status = 'opted_out'`.
2. All future invitation-creation attempts for this identity are blocked — practically, this means matching on name+relationship pattern within the family group before allowing a new `invitations` insert, since there's no stable external identifier (email/phone) guaranteed to exist.
3. `photo_persons.face_blurred = true` set on all existing tags; face matching/collection entry (if they'd been active) is deleted from Rekognition.

## Subscription-lifecycle reuse

The same `Q_CRON` daily-sweep pattern (grace period → terminal state, with day 1/30/60/85 notifications) is reused for the subscription grace/cold-storage/deletion lifecycle in section 11 of the product doc — same job, different table (`family_groups.subscription_status`/`grace_period_end`/`cold_storage_end`) — no need for a second scheduler.

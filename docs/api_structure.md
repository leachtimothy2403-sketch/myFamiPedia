# myFamiPedia — API Structure

REST API, Node.js/Express. Auth via JWT access token + refresh token (Redis-backed session store). All routes under `/api/v1`. Every route is scoped to `family_group_id` (from token) except public invitation-accept links.

## Auth & session

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Creates account + first `persons` record (self) |
| POST | `/auth/login` | Password login, returns access + refresh token |
| POST | `/auth/magic-link/request` | Passwordless: emails a one-time sign-in link |
| POST | `/auth/magic-link/verify` | Exchanges the link's token for access + refresh token |
| POST | `/auth/refresh` | Rotates refresh token |
| POST | `/auth/logout` | Revokes session in Redis |
| POST | `/persons/:id/administrator/nominate` | Person nominates their own administrator |
| POST | `/persons/:id/administrator/confirm` | Fallback path: closest connected member confirms |

## Family tree (Section 1)

| Method | Path | Notes |
|---|---|---|
| GET | `/family-groups/:id/tree` | Full graph for canvas render (persons + relationships) |
| GET | `/persons/:id` | Profile: header stats, tags, timeline, connections |
| PATCH | `/persons/:id` | Edit profile fields (own profile or admin-managed deceased profile) |
| GET | `/persons/:id/summary` | AI-generated "who she was" paragraph (labelled) |
| GET | `/persons/:id/timeline` | Dated events, voice-recording flags |
| GET | `/persons/:id/memories` | Paginated memories feed for this profile |
| POST | `/persons/:id/ask` | Ask feature — returns real clip match(es) first, AI synthesis fallback, gap-acknowledgment if neither |
| GET/POST | `/relationships` | Create/list edges between `persons` |
| POST | `/memories/:id/react` | Lightweight reaction ("this touched me" etc.) |
| DELETE | `/memories/:id` | Contributor only. Succeeds only if unlinked, unreacted, non-voice, non-posthumous — else 409, use retract instead |
| POST | `/memories/:id/retract` | Contributor only. Soft-hides a linked/reacted memory; notifies anyone who reacted to it |
| POST | `/memories/:id/restore-request` | Administrator only. Notifies the original contributor that a restore has been requested |
| POST | `/memories/:id/restore` | Contributor only. Reverses a retraction — administrators cannot call this directly |

## Automatic collection (Section 2)

| Method | Path | Notes |
|---|---|---|
| POST | `/collection/camera-roll/sync` | Mobile app pushes new photo hashes/metadata (device-side scan trigger) |
| GET | `/collection/proposed` | Pending proposed-memory cards for review-tier users |
| POST | `/collection/proposed/:id/accept` | Two-tap add to tree |
| POST | `/collection/proposed/:id/reject` | Discard proposal |
| GET/PATCH | `/persons/:id/privacy-tier` | Get/set tier 1–3 (self only, never admin-writable) |
| GET/PATCH | `/persons/:id/question-frequency` | never/few-days/weekly/daily |
| GET | `/persons/:id/question-prompt` | Next adaptive question-stream prompt |
| POST | `/question-prompt/:id/answer` | Voice or text answer, feeds `memories` |

## AI-guided interviews (Section 3)

| Method | Path | Notes |
|---|---|---|
| GET | `/interview-questions` | Curated bank, filterable by life phase |
| POST | `/interview-sessions` | Start facilitated session against a profile |
| POST | `/interview-sessions/:id/answers` | Attach recorded answer (audio) to a question |
| POST | `/interview-sessions/:id/complete` | Ends session → triggers transcription job → notifies family |
| GET | `/interview-sessions/:id` | Session status/transcript |

## Posthumous contribution (Section 4)

| Method | Path | Notes |
|---|---|---|
| POST | `/persons/deceased` | Administrator-only: creates profile in "collecting memories" state |
| PATCH | `/persons/:id/state` | collecting ↔ complete (administrator only) |
| POST | `/persons/:id/memories` | Any family member contributes memory/photo/story |

## Invitations & consent lifecycle

| Method | Path | Notes |
|---|---|---|
| POST | `/invitations` | Two entry points: (1) auto-triggered by naming someone in a photo/memory, carries the triggering photo; (2) manual "add family member" from the tree — name, relationship, and optionally email/phone, no photo required. Neither email nor phone given → returns a shareable link for the inviter to send themselves |
| GET | `/invitations/:token` | Public accept/decline landing (no auth) |
| POST | `/invitations/:token/accept` | Moves person pending → active; triggers holding-space processing |
| POST | `/invitations/:token/decline` | pending → declined, starts 90-day grace period |
| POST | `/invitations/:id/reinvite` | One allowed re-invite within grace window |
| POST | `/persons/:id/opt-out` | declined/any → permanently opted out |
| GET | `/persons/:id/holding-space-count` | Private count ("X moments waiting") for inviter only |

## Voice pipeline & consent

| Method | Path | Notes |
|---|---|---|
| GET | `/persons/:id/voice-model` | Status: none/instant/professional, consent state |
| POST | `/persons/:id/voice-model/preview` | Moment 1 — 10s clip, no consent yet |
| POST | `/persons/:id/voice-model/consent` | Moments 2–3 — decision + confirmation, records consent_date/by |
| POST | `/persons/:id/voice-model/pause` | Reversible pause (self or nominated administrator) |
| POST | `/persons/:id/voice-model/revoke` | Ongoing control |

## Search

| Method | Path | Notes |
|---|---|---|
| GET | `/search?q=&mode=keyword\|semantic&person=&date_from=&date_to=&media_type=&contributor=` | Keyword = Postgres full-text; semantic = pgvector cosine similarity over `memories.embedding` |

## Moderation

| Method | Path | Notes |
|---|---|---|
| POST | `/flags` | Reporter flags content, required description |
| GET | `/flags` | Administrator review queue |
| PATCH | `/flags/:id` | Remove/dismiss |
| POST | `/flags/:id/appeal` | Contributor appeals removal with new description |

## Subscription & family group

| Method | Path | Notes |
|---|---|---|
| GET | `/family-groups/:id/subscription` | Status, grace_period_end |
| POST | `/family-groups/:id/subscription/takeover` | Any member becomes paying member + administrator, one tap |

## Notifications

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | Feed |
| GET/PATCH | `/notifications/settings` | Per-notification-type on/off, per user |

## Cross-cutting

- **Uploads**: media never passes through Express — API issues presigned R2 upload URLs (`POST /uploads/presign`), client uploads directly, then calls `POST /uploads/:id/complete` to register in `memories`/`holding_space`.
- **Idempotency**: all POSTs from mobile background sync (camera-roll sync, question answers) accept an `Idempotency-Key` header — flaky mobile networks retry safely.
- **Privacy enforcement**: every read route filters through the privacy rules in the data layer (see task 9), not just in controller logic — see companion doc.

# myFamiPedia — Media Storage & Processing Pipeline

Photo → detection (no identity) → human tap-to-tag → profile, with GDPR-safe timing as the hard constraint (no biometric processing, ever, on anyone — consented or not).

**2026-07-18 rewrite.** This doc originally described an automated Rekognition/Vision face-*matching* pipeline (`SearchFacesByImage`/`IndexFaces` against a per-family biometric collection). That design was disabled the same day it was found still wired into production — running biometric identification against family members, including bystanders who never consented, is GDPR Article 9 exposure that hadn't been cleared by counsel. It's not coming back for the beta. What's below reflects the actual replacement, detailed in full in `docs/photo_pipeline_beta_architecture.md` (source of truth for schema/routes); this doc stays as the narrative walkthrough.

## 1. Ingestion

Mobile app requests OS photo-library permission from the device owner only (the consented member). On each sync interval (foreground open + periodic background fetch, best-effort on iOS):

1. App computes a manifest of new/changed photos: perceptual hash, EXIF (taken_at, location if present), local asset id.
2. For each new photo, the app gets a presigned R2 upload URL (`POST /uploads/presign`, `context: "photo"`) and PUTs the bytes directly to R2 — the API never touches image bytes in transit.
3. The app posts the resulting `r2Key`s (plus `takenAt`/`location`) to `POST /collection/camera-roll/sync`, which inserts the `photos` rows directly (`uploaded_by` = device owner's person_id) and enqueues, per photo: a `face-detection` job, an `embedding` job, and a scene-classification job — plus one family-wide clustering job per sync batch (not per photo).

Note: `POST /uploads/:id/complete` (the general-purpose upload-completion endpoint, also used for voice/interview uploads) can *also* create a `photos` row directly for a manually-uploaded single photo — but that path doesn't enqueue any of the jobs above. Only camera-roll sync currently triggers face detection, classification, or clustering. Worth deciding whether manual single-photo uploads should get the same treatment; flagging as a known gap rather than fixing it here.

## 2. Face detection & tap-to-tag (docs/photo_pipeline_beta_architecture.md sections 1-3)

**Detection only, never identity.** The `face-detection` worker calls Rekognition `DetectFaces` — bounding boxes and a confidence score, nothing else — and persists each box to `photo_faces` (geometry, no name attached). `photos.face_count` is denormalized alongside for the crowd-mode check (section 4 below). No collection, no enrollment, no matching call is ever made against these boxes.

Identity only ever comes from a human tap: `GET /photos/:id/faces` returns the detected boxes as tap targets (joined against any existing tag so the client can show which ones already have a name), and `POST /photos/:id/faces/:faceId/tag` resolves one of three ways depending on who the tapper picks:

- **Existing active person:** tag is written straight to `photo_persons` as `confirmed`, visible immediately. No review step of any kind today — see the "trust-list review window" open item in the architecture doc for the gap this leaves.
- **Existing but not-yet-active person** (still on their invitation): nothing is written to `photo_persons` yet — the tag goes into `holding_space` (raw `r2_key` + `face_coordinates`), invisible until they accept.
- **Unrecognized face, brand-new person:** goes to the family administrator's approval queue (`person_tag_proposals`) rather than creating a person outright — the "consequential act" principle from `docs/family_administrator_and_privacy_model.md`. Approving fires the same person + invitation creation as a manual add, with the *original tapper* (not the approving administrator) recorded as the inviter.

Faces nobody has tapped yet just sit in `photo_faces` with no tag — visible as open tap targets, surfaced proactively only through the classification/clustering pipeline (section 5 of the architecture doc), never through any kind of automated identity guess.

## 3. Holding space → profile (on acceptance)

When a pending person accepts their invitation (`POST /invitations/:token/accept`):
1. `persons.status` → `active`, `users` row created/linked.
2. Enqueue a one-time `holding-space-drain` job. This is now a straight promotion, not a re-scan: every `holding_space` row for this person already carries the exact `photoId`/`faceId`/`faceCoordinates` (or `memoryId`, for text-memory mentions) a human supplied at tag time, so there's nothing left to "discover." The job just writes the corresponding `photo_persons`/`memory_persons` row directly against the original photo or memory — no vision service call, no matching, no retroactive scan of the family's photo library.
3. `holding_space` rows for this person are archived (`archived_at` set, kept for provenance) once promoted.

The old design's "enroll their face, then retroactively re-scan every existing family photo to find more appearances" step is gone entirely — it depended on matching, which no longer exists. The tradeoff is explicit: a newly-active person's profile only ever contains what a human has actually tagged them in, not everything they technically appear in.

## 4. Decline / expiry paths

- **Decline:** `persons.status → declined_grace`, `invitations.grace_period_end = now() + 90d`. Holding space untouched (frozen).
- **90 days elapse, no acceptance:** scheduled job (`Q_CRON`, daily) finds expired grace periods → permanently deletes that person's `holding_space` rows and R2 objects referenced only there. Raw photos that live in `photos` (uploaded as someone else's general memory) are *not* deleted — only the `photo_persons` tag linking them to this person is removed, per the "raw photos remain as inviting member's memories" rule.
- **Permanent opt-out:** any state → `opted_out`. Existing `photo_persons` rows for them get a `face_blurred = true` flag (rendered blurred everywhere), profile becomes non-clickable, `invitations` table gets a poison-pill row preventing any future invite creation for that person identity. `deleteFaces` is still called against that family's Rekognition collection as a cleanup step — not because the current pipeline ever indexes anyone, but because any family that used the app before 2026-07-18 may have real entries left over from when matching was live, and those need to actually be purgeable for GDPR erasure to be true.

## 5. Storage layout (R2)

```
r2://myfamipedia-media/{family_group_id}/photos/{photo_id}.jpg
r2://myfamipedia-media/{family_group_id}/holding/{person_id}/{holding_id}.jpg
r2://myfamipedia-media/{family_group_id}/voice/{interview_answer_id}.m4a
```
Bucket-level lifecycle rule purges `holding/{person_id}/*` on the same schedule as the DB deletion in step 4, so storage and metadata deletion stay in sync.

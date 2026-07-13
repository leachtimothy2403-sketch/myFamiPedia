# myFamiPedia — Media Storage & Processing Pipeline

Photo → face detection → holding space → profile, with GDPR-safe timing as the hard constraint (no biometric processing on anyone who hasn't consented).

## 1. Ingestion

Mobile app requests OS photo-library permission from the device owner only (the consented member). On each sync interval (foreground open + periodic background fetch, best-effort on iOS):

1. App computes a manifest of new/changed photos: perceptual hash, EXIF (taken_at, location if present), local asset id.
2. Manifest posted to `POST /collection/camera-roll/sync`.
3. API diffs against `photos` table for that person; for genuinely new items, returns presigned R2 upload URLs.
4. App uploads photo bytes directly to R2 (API never touches image bytes in transit).
5. App confirms via `POST /uploads/:id/complete` → row created in `photos` (uploaded_by = device owner's person_id).
6. API enqueues a `face-detection` job onto Redis for that photo.

## 2. Face detection & matching (Q_FACE worker)

**Face collection scope is the core privacy control.** Each `family_group` has one Rekognition/Vision "collection" (a biometric index), and only `persons.status = 'active'` members ever have their face indexed into it. Pending, declined, and opted-out people are never added — the system is structurally incapable of recognizing them, which is what makes "no face recognition during holding period" true at the infrastructure level rather than just a policy.

Worker steps:
1. Call Rekognition/Vision `DetectFaces` on the photo → bounding boxes.
2. For each face, call `SearchFacesByImage` against the family's collection.
3. **Match found (active member):** write `photo_persons` row (`identification_status = 'auto_matched'`) → create a `proposed_memories` row for the profile owner's review queue (or auto-commit as a `memories` row if that person's privacy tier = 1).
4. **No match:** face bounding box is recorded transiently in the job result but nothing is written to `photo_persons` or any biometric store — it surfaces in the review card as "unrecognized face — tag someone?" with just the crop, no identity inference.
5. If a user manually tags an unmatched (or wrongly matched) face with a name that doesn't already have an `active` profile: this is the "naming triggers invitation" rule. It creates a `persons` row (`status = 'invited_pending'`), an `invitations` row, and moves the photo into that person's `holding_space` (raw `r2_key` + `face_coordinates`, unprocessed — face is *not* added to the Rekognition collection).
6. Any subsequent photos of that same still-pending person are **not** auto-detected as them (no template exists to match against) — they land in `holding_space` only if someone manually tags that photo too. This is a deliberate limitation: it trades recall for GDPR cleanliness.

## 3. Holding space → profile (on acceptance)

When a pending person accepts their invitation (`POST /invitations/:token/accept`):
1. `persons.status` → `active`, `users` row created/linked.
2. Enqueue a one-time `holding-space-drain` job: for every `holding_space` row belonging to this person, enroll their face into the family's Rekognition collection (using tagged photos as training input), then re-run `SearchFacesByImage` retroactively across the family's existing `photos` table to surface any additional appearances that were never manually tagged.
3. All resulting matches become `photo_persons` rows and feed into their profile's memories/timeline in one batch — this is the "profile populates rapidly on acceptance" behavior from the product spec.
4. `holding_space` rows for this person are archived (kept for provenance) rather than deleted immediately.

## 4. Decline / expiry paths

- **Decline:** `persons.status → declined_grace`, `invitations.grace_period_end = now() + 90d`. Holding space untouched (frozen). Face collection still has no entry for them.
- **90 days elapse, no acceptance:** scheduled job (`Q_CRON`, daily) finds expired grace periods → permanently deletes that person's `holding_space` rows and R2 objects referenced only there. Raw photos that live in `photos` (uploaded as someone else's general memory) are *not* deleted — only the `photo_persons` tag linking them to this person is removed, per the "raw photos remain as inviting member's memories" rule.
- **Permanent opt-out:** any state → `opted_out`. Existing `photo_persons` rows for them get a `face_blurred = true` flag (rendered blurred everywhere), profile becomes non-clickable, face permanently excluded from the collection, `invitations` table gets a poison-pill row preventing any future invite creation for that person identity.

## 5. Storage layout (R2)

```
r2://myfamipedia-media/{family_group_id}/photos/{photo_id}.jpg
r2://myfamipedia-media/{family_group_id}/holding/{person_id}/{holding_id}.jpg
r2://myfamipedia-media/{family_group_id}/voice/{interview_answer_id}.m4a
```
Bucket-level lifecycle rule purges `holding/{person_id}/*` on the same schedule as the DB deletion in step 4, so storage and metadata deletion stay in sync.

# myFamiPedia — Media Storage & Processing Pipeline

Photo → detection (no identity) → human tap-to-tag → profile, with GDPR-safe timing as the hard constraint (no biometric processing, ever, on anyone — consented or not).

**2026-07-18 rewrite.** This doc originally described an automated Rekognition/Vision face-*matching* pipeline (`SearchFacesByImage`/`IndexFaces` against a per-family biometric collection). That design was disabled the same day it was found still wired into production — running biometric identification against family members, including bystanders who never consented, is GDPR Article 9 exposure that hadn't been cleared by counsel. It's not coming back for the beta. What's below reflects the actual replacement, detailed in full in `docs/photo_pipeline_beta_architecture.md` (source of truth for schema/routes); this doc stays as the narrative walkthrough.

## 1. Ingestion

Mobile app requests OS photo-library permission from the device owner only (the consented member).

1. App computes a manifest of new photos it hasn't synced yet.
2. For each new photo, the app gets a presigned R2 upload URL (`POST /uploads/presign`, `context: "photo"`) and PUTs the bytes directly to R2 — the API never touches image bytes in transit.
3. The app posts the resulting `r2Key`s (plus `takenAt`/`location`) to `POST /collection/camera-roll/sync`, which inserts the `photos` rows directly (`uploaded_by` = device owner's person_id) and enqueues, per photo: a `face-detection` job, an `embedding` job, and a scene-classification job — plus one family-wide clustering job per sync batch (not per photo).

**2026-07-19 update — the mobile trigger for this now exists.** `POST /collection/camera-roll/sync` and the whole detection/classification/clustering pipeline behind it were built and tested in an earlier session, but nothing on-device ever called it — the route existed with no caller. `collection/camera-roll-sync.tsx` (new, reachable from the home tab's "Sync camera roll" button) is that caller: on a manual "Sync now" tap, it requests `expo-media-library` permission, pulls new photos since the last sync via `MediaLibrary.getAssetsAsync`, uploads each one through the same presign → PUT → register flow as the design doc describes, and batches the registration calls (15 photos per `POST /collection/camera-roll/sync` call).

Two deliberate scope cuts, both worth revisiting once this manual path is proven out rather than guessed at:

- **No background/automatic triggering.** The original design's "foreground open + periodic background fetch" is only half built — `expo-background-fetch`/`expo-task-manager` are installed as dependencies but never wired to anything. This is a manual button only; the user has to open the app and tap "Sync now." Wiring real background scanning adds native-config and testing complexity (iOS background fetch timing is opportunistic, not guaranteed, and can't be verified without a real device running in the background over time) that seemed better to defer until the manual path itself has been confirmed working on-device.
- **No perceptual hashing.** Rather than tracking every synced photo's hash/asset id (unbounded local storage, no mechanism for it in this app yet), the sync screen keeps a single "newest photo timestamp already synced" cursor in `expo-secure-store` and asks for only what's newer next time. A device's very first sync defaults to the last 60 days rather than its entire lifetime library, to avoid a multi-thousand-photo foreground upload/classification run on the first tap. Practical consequence: if a photo's `taken_at` metadata is edited after being synced, or the cursor gets reset, it could be re-uploaded as a duplicate — the pipeline already tolerates duplicate photos correctly (clustering/dedup was verified against this scenario earlier this session), so this is a low-severity, accepted tradeoff rather than a silent correctness bug.

New mobile dependency: `expo-media-library` — not yet installed, needs `npx expo install expo-media-library` run once (adds the correct SDK-54-compatible version to `apps/mobile/package.json` itself, same reason a pinned version wasn't guessed here). `app.json` already has the plugin entry with a permission description.

**2026-07-19 update — resolved, deliberately not symmetric with camera-roll sync.** `POST /uploads/:id/complete` (also used for voice/interview uploads) is the entry point for `collection/add-photo.tsx` — a mobile screen that didn't exist until this session, the first UI to call this path for a photo at all. It's treated as the "pull" path (`docs/photo_pipeline_beta_architecture.md` section 7): the user deliberately picked this exact photo to become a memory, which already answers the question scene classification and clustering exist to ask. So unlike camera-roll sync, it only enqueues `face-detection` and `embedding` — no `scene-classification`, no `clustering`, no `proposed_memories` row. (An earlier fix this session made it enqueue the full camera-roll job set for symmetry; that was wrong and got walked back once a live test hit AWS DetectLabels/DetectFaces IAM permission errors and forced a closer look at what should actually run.) The client goes straight to `collection/compose.tsx` afterward rather than the review queue, since there's nothing there to review for a photo the user already decided is a memory.

Also fixed this session: photo bytes headed to Rekognition or Claude weren't format-normalized anywhere — an iPhone's native HEIC photo failed Rekognition outright (`InvalidImageFormatException`) and would have silently mismatched Claude's hardcoded `image/jpeg` media type had a HEIC photo ever reached stage 2 classification. `src/services/imageNormalization.service.ts` converts HEIC/HEIF to JPEG (via `heic-convert`, not `sharp` — sharp's published binaries exclude HEIC decoding over HEVC patent licensing) before bytes reach either vendor; wired into all three call sites (`faceDetection.worker.ts`, `sceneClassification.worker.ts`, `sceneClassificationReview.worker.ts`).

## 2. Face detection & tap-to-tag (docs/photo_pipeline_beta_architecture.md sections 1-3)

**Detection only, never identity.** The `face-detection` worker calls Rekognition `DetectFaces` — bounding boxes and a confidence score, nothing else — and persists each box to `photo_faces` (geometry, no name attached). `photos.face_count` is denormalized alongside for the crowd-mode check (section 4 below). No collection, no enrollment, no matching call is ever made against these boxes.

Identity only ever comes from a human tap: `GET /photos/:id/faces` returns the detected boxes as tap targets (joined against any existing tag so the client can show which ones already have a name), and `POST /photos/:id/faces/:faceId/tag` resolves one of three ways depending on who the tapper picks:

- **Existing active person:** tag is written straight to `photo_persons` as `confirmed`, visible immediately. No review step of any kind today — see the "trust-list review window" open item in the architecture doc for the gap this leaves.
- **Existing but not-yet-active person** (still on their invitation): nothing is written to `photo_persons` yet — the tag goes into `holding_space` (raw `r2_key` + `face_coordinates`), invisible until they accept.
- **Unrecognized face, brand-new person:** goes to the family administrator's approval queue (`person_tag_proposals`) rather than creating a person outright — the "consequential act" principle from `docs/family_administrator_and_privacy_model.md`. Approving fires the same person + invitation creation as a manual add, with the *original tapper* (not the approving administrator) recorded as the inviter.

Faces nobody has tapped yet just sit in `photo_faces` with no tag — visible as open tap targets, surfaced proactively only through the classification/clustering pipeline (section 5 of the architecture doc), never through any kind of automated identity guess.

**2026-07-19 update.** `collection/compose.tsx` is the first UI to actually call `GET /photos/:id/faces` and `POST /photos/:id/faces/:faceId/tag` — reached from `add-photo.tsx`'s pull-path flow above. It renders tap targets over each detected face (a new `GET /photos/:id` endpoint supplies the presigned photo URL needed to display it at all — nothing returned one for an arbitrary `photo_id` before this), lets the tapper pick from the family tree, and separately collects memory content/date, submitted via `POST /memories`. Still not built: tapping a face to propose a *brand-new* person (branch (c) above, the admin-approval-queue path) — this screen only tags existing active or still-pending members. Also still not built: reaching this same tap-to-tag flow from the review queue's Accept button (`collection/review.tsx`) — accepting a `proposed_memories` candidate creates a bare `memories` row server-side with no content yet, and there's no endpoint to add content to an existing memory afterward, so that path needs its own design rather than reusing `compose.tsx`'s create-a-new-memory flow as-is.

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

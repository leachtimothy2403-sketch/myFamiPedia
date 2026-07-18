# myFamiPedia — Beta Photo Pipeline Architecture (no automated face recognition)

Architecture/schema plan for replacing the automated face-matching pipeline (disabled 2026-07-18, see `docs/family_administrator_and_privacy_model.md` section 5 and that day's handover) with the detection-only, human-tagged flow decided in that session — sections 5-7 of the design doc. Nothing in this document is implemented yet. It corrects/replaces `docs/media_pipeline.md` section 2-3 and `docs/section2_pipeline.md` section 1, which describe the retired auto-match design; those docs should be updated to point here once this is built, not before.

Grounded against the actual schema (`docs/data_model.md`, migrations 001-022) and actual routes (`collection.routes.ts`, `invitations.routes.ts`) as they exist today, not the aspirational docs — called out inline where they diverge.

## 0. What's already true, what this changes

**Unchanged:** ingestion. `POST /collection/camera-roll/sync` → `photos` row → `faceDetectionQueue.add("detect", ...)` + `embeddingQueue.add("embed-photo", ...)`. R2 storage layout, presigned upload flow, `photos.embedding` (Voyage multimodal) — none of that touched biometric identity and none of it changes.

**Changes:** everything downstream of "a photo now exists and detection has run." Today `faceDetection.worker.ts` calls `DetectFaces` only and returns the result without persisting it — there's nowhere for a face box to live between "detected" and "someone taps it," and there's no tap-to-tag endpoint at all yet. `holdingSpaceDrain.worker.ts` (the "profile populates on acceptance" step) currently does nothing but count pending rows, because its only content-surfacing mechanism was the retroactive match that's now disabled. `proposed_memories` currently has nothing writing to it either, but it isn't going away — it's still the review queue for automatically-surfaced candidates, just fed by clustering/classification instead of face-match (section 9). This doc designs the replacement for all three gaps.

## 1. New table: `photo_faces` — detected regions, no identity

```sql
CREATE TABLE photo_faces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  face_coordinates jsonb NOT NULL, -- bounding box from DetectFaces
  confidence numeric,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_photo_faces_photo ON photo_faces(photo_id);
```

`processDetectJob` (already calls `detectFaces` only, per today's fix) persists each returned box as a row here instead of just returning it. This is geometry, not identity — no Article 9 exposure, matches the design doc's "detection isn't biometric identification data" reasoning directly. `GET /photos/:id/faces` (new endpoint) returns these, joined against `photo_persons` so the client can distinguish tap targets that already have a name from ones that don't.

`photos` also gains `face_count int` (denormalized count from the same job, avoids a join for crowd-mode checks — see section 4).

## 2. Manual tap-to-tag — the core flow (design doc section 7)

New endpoint: `POST /photos/:id/faces/:faceId/tag`. Three branches on the body:

**(a) `{ personId }` — existing active person.** Writes `photo_persons` (see schema change below), and prompts the compose flow ("what/where/when") to produce a `memories` row linked via `memory_persons` + `memory_photos` — same destination shape as any other memory, `provenance_type = 'photo'`. Tagging and memory-composition are conceptually two steps (tag the face now, describe the moment now-or-later) but the API can accept them together in one call if the client already has caption/date from the compose screen; keeping tag-only as a valid partial call matters for crowdsourced completion (section 6 below), where the tagger may not know what/where/when at all, only who.

Takes an optional `memoryId`: if the photo arrived via an accepted `proposed_memories` candidate (section 9), a bare `memories` row already exists for it and tags should attach there via `memory_persons` rather than creating a second memory. Omitted for the plain pull path, where tagging a photo starts a fresh memory.

**(b) `{ personId }` — existing *pending* (`invited_pending`) person.** Same tap action, different destination: per `docs/media_pipeline.md` section 3's still-correct rule ("photo, and any other data specifically about them, routes to holding_space, unprocessed"), this writes a `holding_space` row (`media_type = 'photo'`, `r2_key` + `face_coordinates` from the `photo_faces` row) instead of `photo_persons`/`memories` directly. Nothing about this person is visible anywhere until they accept. This is the same rule already governing photo-tag-triggered `holding_space` writes today, just now fed by a manual tap instead of an auto-match.

**(c) `{ newPersonName, relatedToPersonId, relationshipType }` — unrecognized face, new person.** Per design doc section 2: this does *not* create a `persons`/`invitations` row directly. It writes a new `person_tag_proposals` row (schema below) into the family administrator's approval queue. `invited_by_person_id` on the eventual invitation is the *tagger*, not the approving admin — the proposal row needs to carry that through. Only on admin approval does today's `POST /invitations` logic fire (persons row + relationship + invitation), immediately followed by writing the original tag into that new person's `holding_space` per branch (b) — a brand-new person is pending by definition, so their first-ever photo tag goes straight into holding, same as any other pending person's tag.

```sql
CREATE TABLE person_tag_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id uuid NOT NULL REFERENCES family_groups(id),
  proposed_name text NOT NULL,
  proposed_by_person_id uuid NOT NULL REFERENCES persons(id), -- the tagger, becomes invited_by_person_id on approval
  related_to_person_id uuid NOT NULL REFERENCES persons(id),
  relationship_type text NOT NULL,
  photo_id uuid NOT NULL REFERENCES photos(id),
  face_id uuid NOT NULL REFERENCES photo_faces(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz DEFAULT now()
);
```

Approve/reject endpoints (`POST /person-tag-proposals/:id/approve|reject`), gated to the family administrator per `docs/family_administrator_and_privacy_model.md` section 1 — this is exactly the "consequential act" gate that doc describes, now with a concrete table to gate. Same two-tap shape as the existing proposal-card UI pattern.

## 3. `photo_persons` schema changes

```sql
ALTER TABLE photo_persons
  ADD COLUMN face_id uuid REFERENCES photo_faces(id),
  ADD COLUMN tagged_by uuid REFERENCES persons(id);
```

`identification_status` keeps its existing values but `'auto_matched'` is now dead (nothing writes it) — `'confirmed'` becomes the only value manual tagging ever produces; `'pending'` stays as the default for a detected-but-untagged face if a row ever gets pre-created (it currently isn't — rows are only inserted at tag time — so in practice every `photo_persons` row will be `'confirmed'` going forward; flagging that `'pending'`/`'auto_matched'` are effectively legacy values worth pruning from the CHECK constraint in a follow-up migration rather than carrying forward indefinitely).

`face_id` is nullable (a tag could theoretically be added without a detected box, e.g. someone tags a face `DetectFaces` missed) but where present, a partial unique index prevents two different identity claims landing on the same detected box:

```sql
CREATE UNIQUE INDEX idx_photo_persons_face_unique ON photo_persons(face_id) WHERE face_id IS NOT NULL;
```

## 4. Crowd-mode (design doc section 6)

`photos.face_count` (section 1) is compared against a threshold at the application/query layer, not baked into a stored boolean — keeps the threshold tunable without a backfill. `CROWD_MODE_THRESHOLD` as a config constant, **not yet picked** (matches the design doc's own open item). Effect: when `face_count > threshold`, the client suppresses any proactive "N faces detected, who are they?" prompt/notification for that photo. `GET /photos/:id/faces` still returns every box regardless — tap targets are unaffected, since identifying someone in a crowd photo is explicitly still a pull action a family member can take, just never pushed.

## 5. Content/scene classification (design doc section 7)

Two stages, two different tools, deliberately not one classifier doing both jobs — cheap triage across every synced photo, expensive judgment only on the subset that clears triage.

**Stage 1 — Rekognition `DetectLabels`, every synced photo.** Enqueued alongside `detect` at ingest time in `collection/camera-roll/sync`, same trigger point, new queue (`scene-classification`). This is a structurally different, non-biometric Rekognition API from the disabled `SearchFacesByImage`/`IndexFaces` calls — stateless, single-image, no collection, no enrollment, nothing persisted that identifies a person — so running it doesn't reopen the GDPR question the earlier session closed. Current pricing: **$0.001/image** for the first 1M images/month, dropping to $0.0006-0.00025/image at higher volume (AWS Rekognition pricing page, checked 2026-07). Returns a flat list of generic labels with confidence scores (Cake, Beach, Outdoors, Crowd, Gathering, etc.) — cheap and fast, but no sense of *why* something matters and no caption text. The job checks the returned labels against a curated allowlist above a confidence bar and sets `triage_passed` — this is pure filtering, not a final verdict.

**Stage 2 — Claude (Haiku), only for photos where `triage_passed = true`.** A second, rate-limited queue (`scene-classification-review`) so the more expensive calls don't scale 1:1 with raw ingest volume. Reuses the existing `claude.service.ts` HTTP pattern (already used for follow-up-question generation) with an added image content block — small lift, not new plumbing. Confirms or vetoes stage 1's guess by actually looking at the full scene (catches, e.g., "Cake" firing on a bakery display photo rather than a real celebration) and writes the actual caption suggestion text. Real cost, checked 2026-07: a ~2000×2000 photo runs roughly 5,300 input tokens; on Haiku 4.5's ~$1/M input rate that's about **$0.005/image**, vs. ~$0.015/image on Sonnet — call it 5-15x Rekognition's per-image cost depending on model choice, which is exactly why it only runs on the fraction of photos stage 1 already flagged as promising, not the full camera-roll backlog a family syncs on first use.

```sql
CREATE TABLE photo_classifications (
  photo_id uuid PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  labels jsonb NOT NULL DEFAULT '[]', -- stage 1: raw DetectLabels output [{label, confidence}]
  triage_passed boolean NOT NULL DEFAULT false, -- stage 1: cleared the curated allowlist threshold
  suggested_caption text, -- stage 2 only, null unless triage_passed
  is_candidate_worthy boolean NOT NULL DEFAULT false, -- stage 2's final confirm/veto; meaningless unless triage_passed
  created_at timestamptz DEFAULT now(),
  reviewed_at timestamptz -- set when stage 2 runs, null while still awaiting/skipped review
);
```

Used two ways once `is_candidate_worthy = true`: (1) `suggested_caption` prefills the compose flow once a human starts tagging that photo — accept or edit, never auto-posted; (2) feeds a `proposed_memories` row (section 9) for the proactive-suggestion surface.

**Deliberately not solved here:** the "last day of vacation" case — personally significant, visually unremarkable, no label or caption model catches it. That's not a gap to engineer around; it's why the pull path (section 7) exists — the user just adds it as a memory themselves, no classification involved at all. Clustering (section 6) can occasionally surface the same photo anyway via time/location alone, but that's incidental, not a guarantee, and shouldn't be treated as this pipeline's answer to that case.

**Worth a real check before this ships, not assumed clean:** Anthropic's API data-retention/training-use terms for photo bytes sent via the Messages API — a smaller question than the AWS/Rekognition biometric review, since this isn't biometric data, but still a new vendor boundary photo content crosses and deserves the same category of scrutiny.

Open question, not blocking: the exact stage-1 label allowlist and confidence threshold — needs a first pass against real sample photos rather than being designed abstractly here.

## 6. Time/location clustering (design doc section 7)

Batch job, not per-photo — runs after each sync batch completes (or daily via the existing `Q_CRON` pattern; incremental-after-sync is more responsive and cheap enough given it's pure metadata arithmetic, no image content touched at all).

```sql
CREATE TABLE photo_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id uuid NOT NULL REFERENCES family_groups(id),
  representative_taken_at timestamptz,
  location jsonb, -- centroid {lat, lng}, informational only
  created_at timestamptz DEFAULT now()
);
CREATE TABLE photo_cluster_photos (
  cluster_id uuid NOT NULL REFERENCES photo_clusters(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, photo_id)
);
```

Clustering rule: group a family's un-clustered photos by `taken_at` proximity (rolling window, e.g. photos within N hours of each other chain together — needs tuning) and, where GPS exists, proximity (haversine distance under a threshold, e.g. ~2km — also needs tuning) into a candidate "outing." Photos without EXIF location still cluster on time alone; photos without either are never clustered, just available via the pull path. `photo_clusters` itself carries no accept/dismiss state — that lives on `proposed_memories` (section 9), which is what the user actually reviews. Both threshold numbers are open — need real usage data or at least a product judgment call, not something to hardcode confidently here.

## 7. Two entry points, one flow

Confirmed by design doc section 7: the pipeline is one flow — photo → detect → human taps to tag → human fills in what/where/when — reached two ways:

- **Proactive:** clustering or classification flags a candidate and writes a `proposed_memories` row (section 9) — the review-card queue, unchanged UI shape from today. Opening a card (accept) creates a bare `memories` row already linked to its photo(s), then drops the user into tap-to-tag to say who's in it. No push notification volume decisions made here — that's a section-2-pipeline-doc-style cadence/throttling question, out of scope for this doc.
- **Pull:** user picks any photo themselves and starts tagging — `GET /photos/:id/faces` + `POST /photos/:id/faces/:faceId/tag` as described above, no proposal or cluster involved at all, a fresh memory created directly.

Both terminate in the same tap-to-tag step and the same `memories` row shape with `memory_persons`/`memory_photos` attached — they just differ in who initiates and whether a `proposed_memories` row exists in between.

## 8. Crowdsourced tag completion

Same `POST /photos/:id/faces/:faceId/tag` endpoint, callable by any active family member, not just the photo's uploader or an existing tagger — no new permission check beyond "is an active member of this family group," matching design doc section 7's "any family member ... can add a tag for a person who hasn't yet been identified." The `idx_photo_persons_face_unique` constraint (section 3) is what actually enforces "add-only, not edit" at the data layer: once a face box has a `photo_persons` row, a second tag attempt on the same `face_id` fails the unique index rather than silently overwriting someone else's identification. Correcting a wrong tag is a separate, deliberately unbuilt-here concern (dispute/flag path, `flags` table already exists for exactly this).

## 9. `proposed_memories` — survives, now fed by clustering/classification instead of face-match

Correction from an earlier draft of this doc: `proposed_memories.person_id` was never "the tagged subject" — `docs/data_model.md`'s own comment on the column says `-- profile owner (device owner)`, and the notes section confirms it: "the review queue for the *consented device owner's own* photos awaiting a swipe/tap decision." That meaning doesn't change here. What changes is only *what triggers a row* — clustering (section 6) and classification (section 5) replace `SearchFacesByImage` as the signal, and critically, **no one is identified via tags at proposal time**, because there's no facial recognition to identify them. A proposed row says "this looks like a candidate moment from your camera roll," nothing more — who's in it is still entirely unknown until a human taps faces after accepting.

Schema change to support both single-photo (classification) and multi-photo (cluster) candidates:

```sql
ALTER TABLE proposed_memories
  ALTER COLUMN photo_id DROP NOT NULL,
  ADD COLUMN cluster_id uuid REFERENCES photo_clusters(id),
  ADD CONSTRAINT proposed_memories_source_check
    CHECK ((photo_id IS NOT NULL) <> (cluster_id IS NOT NULL)); -- exactly one source
```

Flow, `GET/POST /collection/proposed/...` mostly unchanged from today:

- **Classification** (`photo_classifications.is_candidate_worthy = true`) inserts a `proposed_memories` row with `photo_id` set, `person_id` = the photo's uploader.
- **Clustering** (a new `photo_clusters` row forms) inserts a `proposed_memories` row with `cluster_id` set instead, same `person_id` semantics.
- **Accept** (`POST /collection/proposed/:id/accept`) — today's handler already just creates a bare `memories` row (`provenance_type = 'photo'`, no content, no tags) and marks the proposal accepted; that behavior is still correct, just needs to attach `memory_photos` for either the single `photo_id` or every photo in `cluster_id`'s `photo_cluster_photos`. The resulting `memoryId` is what section 2's tap-to-tag endpoint expects when the user goes on to say who's in it.
- **Reject** — unchanged, soft-deleted, retained for the AI-adaptation loop per `docs/section2_pipeline.md` section 2.

This is, functionally, the closest thing left to the old tier-1 "collect automatically" behavior — just without any auto-submitted identity, since identity now always requires a human tap. It's a genuinely different mechanism from the trust-list review window below, even though both involve a "review before it's fully visible" step — one gates *whether a candidate becomes a memory at all* (this section), the other gates *whether an already-tagged memory shows on one specific profile* (next section). Worth keeping those distinct rather than merging them into one table.

## 9a. Trust-list review window (design doc section 4/7) — separate mechanism

Distinct problem from section 9: a memory that *has* been tagged (via section 2's tap-to-tag, by someone not on the tagged subject's trust list) needs to show immediately in the tagger's own feed and the general family feed, but stay off the *subject's own profile* until they clear it or a review window elapses. `proposed_memories` doesn't fit this — the memory and its `memory_persons` row need to exist and be visible everywhere immediately, only one profile's view is gated, and per-tag not per-memory (design doc section 3's principle, reused here). Proposed mechanism, unchanged from the earlier draft: `memory_persons.tag_status text CHECK (tag_status IN ('confirmed','pending_review'))`, set at tag-insert time by checking the tagger against the subject's trust list, defaulting `confirmed` when trusted. The subject's own profile/timeline query filters `tag_status = 'confirmed'`; every other view ignores the column. This still needs the tier redefinition from design doc section 7 (what the review window actually does — auto-expire vs. require explicit action) before the column's *values* are fully specified; the column itself doesn't depend on that being settled first.

## 10. `holding_space` drain, redesigned (fixes today's stopgap)

Today's fix to `holdingSpaceDrain.worker.ts` left `holding_space` rows un-archived on accept, because the old drain mechanism (enroll face, retroactively re-scan the family's whole photo library) no longer exists. Under this architecture, that retroactive rediscovery isn't needed — every `holding_space` photo row already carries the exact `face_coordinates` and `r2_key` it needs, because branch (b)/(c) in section 2 wrote them there directly at tag time, not via matching. The redesigned drain is much simpler than the old one:

1. For every `holding_space` row belonging to the newly-active person with `media_type = 'photo'`: create the corresponding `photo_persons` row (`identification_status = 'confirmed'`, `tagged_by` = `holding_space.source_person_id`, `face_id`/`face_coordinates` carried over) directly against the original `photo_id` — no re-scan, no matching, just promoting data that was already fully known.
2. For `media_type = 'mention'` rows (the text-memory tagging gap flagged in the design doc section 3, still unfixed): promote into a real `memory_persons` row against the original `memory_id` the same way.
3. Archive the row (`archived_at = now()`) once promoted, as before.

This also directly resolves the design doc's flagged "Bug identified, not yet fixed" in section 3 — the `POST /memories` text-tagging path needs to start writing `holding_space` rows (`media_type = 'mention'`) for any tagged person who isn't yet active, mirroring what photo-tagging already does, so step 2 above has something to promote. That's a `memories.routes.ts` change, in scope for this rebuild since it's the same underlying mechanism.

## Summary of schema changes

- New: `photo_faces`, `person_tag_proposals`, `photo_classifications`, `photo_clusters`, `photo_cluster_photos`.
- `photos`: `+ face_count int`.
- `photo_persons`: `+ face_id uuid`, `+ tagged_by uuid`, new partial unique index on `face_id`.
- `memory_persons`: `+ tag_status text` (section 9a, trust-list review window).
- `proposed_memories`: `photo_id` becomes nullable, `+ cluster_id uuid`, source-check constraint — stays alive, now fed by classification/clustering instead of face-match (section 9).
- New queues/workers: `scene-classification` (new, stage 1 — Rekognition `DetectLabels`, every synced photo), `scene-classification-review` (new, stage 2 — Claude/Haiku, only photos that pass stage 1's triage), `photo-clustering` (new, batch), `faceDetection.worker.ts` (already changed today, persists to `photo_faces` instead of just returning), `holdingSpaceDrain.worker.ts` (redesigned per section 10, replaces today's stopgap).
- `vision.service.ts`: `searchFacesByImage`, `indexFace`, `ensureCollection`, `collectionIdFor` are no longer called by anything under this design — worth trimming the interface down to `detectFaces` + `deleteFaces` (the opt-out path still needs to purge any legacy collection entries) in a follow-up cleanup, not urgent.

## Open items — not yet decided

- Crowd-mode face-count threshold (section 4) — carried over from the design doc, still open.
- Clustering time-window and GPS-proximity thresholds (section 6) — new open item, needs real usage data.
- Stage-1 label allowlist and confidence threshold for scene classification (section 5) — the two-stage architecture and providers are decided, the specific labels/cutoff aren't.
- Anthropic API data-retention/training-use terms for photo bytes sent to stage 2 (section 5) — needs an actual check, not an assumption, before this ships.
- Trust-list review-window semantics (section 9a) — depends on the tier-wording/duration decision the design doc already flagged as open; the `tag_status` column doesn't need that settled first, but its behavior does.
- Proactive-suggestion notification cadence/throttling for `proposed_memories` cards generated by clustering/classification — not designed here, probably an extension of the existing `docs/section2_pipeline.md` section 5 dedup/coalescing pattern rather than a new mechanism.

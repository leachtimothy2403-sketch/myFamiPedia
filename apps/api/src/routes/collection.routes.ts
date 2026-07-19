import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { faceDetectionQueue, embeddingQueue, sceneClassificationQueue, photoClusteringQueue } from "../jobs/queue";
import { HttpError } from "../utils/httpError";
import { notImplemented } from "../utils/notImplemented";
import { presignDownload } from "../services/r2.service";

export const collectionRouter = Router();
const spec = "docs/section2_pipeline.md";

// Device-side scan trigger pushes new photo hashes/metadata. This route's
// job stops at registering the photos and queuing them for downstream
// processing: face DETECTION only (no matching — see
// docs/family_administrator_and_privacy_model.md section 5 and
// docs/photo_pipeline_beta_architecture.md), two-stage scene classification,
// and — once per sync batch, not once per photo — a re-run of the family's
// time/location clustering pass, since a fresh batch of photos might extend
// or form a new "outing" cluster.
collectionRouter.post("/collection/camera-roll/sync", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { photos } = req.body ?? {};
    if (!Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ error: "photos (non-empty array) is required" });
    }

    const inserted = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("photos")
        .insert(
          photos.map((p: { r2Key: string; takenAt?: string; location?: { lat: number; lng: number } }) => ({
            family_group_id: familyGroupId,
            r2_key: p.r2Key,
            uploaded_by: personId,
            taken_at: p.takenAt ?? null,
            // EXIF GPS, same "device extracted it, API just stores it"
            // contract as takenAt — clustering's only consumer (section 6).
            location: p.location ? JSON.stringify(p.location) : null,
            source: "camera_roll",
          }))
        )
        .returning("*")
    );

    await Promise.all(
      inserted.map((photo: { id: string }) => faceDetectionQueue.add("detect", { photoId: photo.id }))
    );
    // Every photo gets embedded in image mode too (docs/search.md's
    // "photos upload complete -> embed the image" trigger), independent of
    // whatever face-detection finds.
    await Promise.all(inserted.map((photo: { id: string }) => embeddingQueue.add("embed-photo", { photoId: photo.id })));
    // Stage 1 of scene classification (docs/photo_pipeline_beta_architecture.md
    // section 5) — stage 2 is enqueued by stage 1 itself, only for photos
    // that pass triage, not from here.
    await Promise.all(inserted.map((photo: { id: string }) => sceneClassificationQueue.add("classify", { photoId: photo.id })));
    // Clustering (section 6) is a family-wide batch pass, not per-photo —
    // one enqueue per sync call regardless of how many photos it contained.
    await photoClusteringQueue.add("cluster", { familyGroupId });
    res.status(201).json({ items: inserted });
  } catch (err) {
    next(err);
  }
});

// Best-effort presign, matching the established pattern for R2 calls
// elsewhere (scheduledJobs.worker.ts's grace-period cleanup: "a missing
// storage integration shouldn't block the DB-side cleanup"). Without this,
// presignDownload's hard throw when R2 isn't configured — correct for a
// write path, where a missing bucket really should block the request — took
// this whole read endpoint down with a 500 in any environment without R2
// credentials (caught by the test suite, which doesn't set them). A photo
// with no resolvable URL should render as "no preview available"
// client-side, not break the entire review queue for every other proposal.
async function safePresignDownload(r2Key: string): Promise<string | null> {
  try {
    return await presignDownload(r2Key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`presignDownload failed for ${r2Key}:`, err);
    return null;
  }
}

// Pending review-tier (tier 2) proposal cards for the caller's own profile.
// A bare proposed_memories row (id/status/photo_id or cluster_id) isn't
// enough for the client to show anything — it needs an actual viewable photo
// and, where one exists, the caption stage 2 classification already wrote.
// Resolves each proposal's source (design doc section 9: exactly one of
// photo_id/cluster_id is set) into a presigned R2 URL plus caption before
// returning.
collectionRouter.get("/collection/proposed", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const proposals = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("proposed_memories").where({ person_id: personId, status: "pending" }).orderBy("created_at", "asc")
    );

    const items = await Promise.all(
      proposals.map(
        async (proposal: { id: string; photo_id: string | null; cluster_id: string | null; created_at: Date }) => {
          if (proposal.photo_id) {
            // Classification-sourced: single photo, and photo_classifications
            // carries the suggested_caption Claude wrote in stage 2
            // (sceneClassificationReview.worker.ts) — a candidate that never
            // reached stage 2, or wasn't confirmed worthy, wouldn't have a
            // proposed_memories row at all, so a caption is expected here.
            const photo = await withRlsContext({ personId, familyGroupId }, (trx) =>
              trx("photos as p")
                .leftJoin("photo_classifications as pc", "pc.photo_id", "p.id")
                .where("p.id", proposal.photo_id!)
                .select("p.r2_key", "pc.suggested_caption")
                .first()
            );
            return {
              id: proposal.id,
              source: "photo" as const,
              photoUrl: photo ? await safePresignDownload(photo.r2_key) : null,
              caption: photo?.suggested_caption ?? null,
              photoCount: 1,
              createdAt: proposal.created_at,
            };
          }

          // Clustering-sourced: no suggested_caption exists (clustering is
          // pure EXIF-metadata arithmetic, section 6 — it never calls
          // Claude), so caption is always null here. Representative photo is
          // the earliest by taken_at among the cluster's photos.
          const clusterPhotos = await withRlsContext({ personId, familyGroupId }, (trx) =>
            trx("photo_cluster_photos as pcp")
              .join("photos as p", "p.id", "pcp.photo_id")
              .where("pcp.cluster_id", proposal.cluster_id!)
              .orderBy("p.taken_at", "asc")
              .select("p.r2_key")
          );
          return {
            id: proposal.id,
            source: "cluster" as const,
            photoUrl: clusterPhotos[0] ? await safePresignDownload(clusterPhotos[0].r2_key) : null,
            caption: null,
            photoCount: clusterPhotos.length,
            createdAt: proposal.created_at,
          };
        }
      )
    );

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// Two-tap accept: promotes the proposal into a real memory (photo
// provenance), then attaches memory_photos for whichever source produced the
// proposal — the single photo_id (classification) or every photo in
// cluster_id's photo_cluster_photos (clustering) — per
// docs/photo_pipeline_beta_architecture.md section 9. The resulting
// memoryId is what tap-to-tag (POST /photos/:id/faces/:faceId/tag's
// memoryId param) expects next, once the user says who's in it.
//
// 2026-07-19: now returns { memoryId, photoId } (200) instead of a bare 204.
// Previously the client had no way to know what it had just created — the
// mobile review queue (collection/review.tsx) could only make the card
// disappear on Accept, with no route into collection/compose.tsx to actually
// tag faces or describe the memory, since it never learned the memoryId.
// photoId is the same representative photo GET /collection/proposed already
// picks for cluster-sourced proposals (earliest by taken_at) — compose.tsx
// only renders tap targets for one photo at a time, so a cluster's other
// photos are attached to the memory (memory_photos, above) but not
// individually tappable from this flow yet.
collectionRouter.post("/collection/proposed/:id/accept", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const proposal = await trx("proposed_memories").where({ id: req.params.id }).first();
      if (!proposal) throw new HttpError(404, "Proposed memory not found");
      if (proposal.status !== "pending") throw new HttpError(409, "This proposal has already been resolved");

      const [memory] = await trx("memories")
        .insert({
          family_group_id: familyGroupId,
          contributor_id: personId,
          provenance_type: "photo",
          media_url: null,
        })
        .returning("id");

      const photoIds = proposal.photo_id
        ? [proposal.photo_id]
        : (
            await trx("photo_cluster_photos as pcp")
              .join("photos as p", "p.id", "pcp.photo_id")
              .where("pcp.cluster_id", proposal.cluster_id)
              .orderBy("p.taken_at", "asc")
              .select("pcp.photo_id")
          ).map((r: { photo_id: string }) => r.photo_id);
      await trx("memory_photos").insert(photoIds.map((photoId: string) => ({ memory_id: memory.id, photo_id: photoId })));

      await trx("proposed_memories").where({ id: proposal.id }).update({ status: "accepted" });
      return { memoryId: memory.id as string, photoId: photoIds[0] as string };
    });
    await embeddingQueue.add("embed-memory", { memoryId: result.memoryId });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Soft-deleted, not removed — retained for the AI-adaptation loop (section 4).
collectionRouter.post("/collection/proposed/:id/reject", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const proposal = await trx("proposed_memories").where({ id: req.params.id }).first();
      if (!proposal) throw new HttpError(404, "Proposed memory not found");
      if (proposal.status !== "pending") throw new HttpError(409, "This proposal has already been resolved");
      await trx("proposed_memories").where({ id: proposal.id }).update({ status: "rejected" });
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Self-only, never admin-writable (docs/privacy_enforcement.md) — the
// privacy_tier_self_write RLS policy is the real backstop; this check is the
// friendly error path, same pattern as the memory deletion routes.
collectionRouter.get("/persons/:id/privacy-tier", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const person = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons").where({ id: req.params.id }).first("privacy_tier")
    );
    if (!person) throw new HttpError(404, "Person not found");
    res.json({ privacyTier: person.privacy_tier });
  } catch (err) {
    next(err);
  }
});

collectionRouter.patch("/persons/:id/privacy-tier", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    if (req.params.id !== personId) {
      throw new HttpError(403, "Privacy tier cannot be changed by anyone other than the person themself");
    }
    const { privacyTier } = req.body ?? {};
    // Tier 1 is retired (migration 025) — it depended on automated face
    // matching that no longer exists, and had no live behavior left. See
    // docs/section2_pipeline.md section 1.
    if (![2, 3].includes(privacyTier)) {
      return res.status(400).json({ error: "privacyTier must be 2 or 3" });
    }
    const [person] = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons").where({ id: req.params.id }).update({ privacy_tier: privacyTier }).returning("privacy_tier")
    );
    res.json({ privacyTier: person.privacy_tier });
  } catch (err) {
    next(err);
  }
});

// Same self-only convention as privacy-tier, though — unlike privacy_tier —
// there's no dedicated RLS policy backstopping it (not called for in
// docs/privacy_enforcement.md), so this app-layer check is the only
// enforcement today. Worth a policy addition if that changes.
collectionRouter.get("/persons/:id/question-frequency", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const person = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons").where({ id: req.params.id }).first("question_frequency")
    );
    if (!person) throw new HttpError(404, "Person not found");
    res.json({ questionFrequency: person.question_frequency });
  } catch (err) {
    next(err);
  }
});

collectionRouter.patch("/persons/:id/question-frequency", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    if (req.params.id !== personId) {
      throw new HttpError(403, "Question frequency cannot be changed by anyone other than the person themself");
    }
    const { questionFrequency } = req.body ?? {};
    if (!["never", "few_days", "weekly", "daily"].includes(questionFrequency)) {
      return res.status(400).json({ error: "questionFrequency must be one of never, few_days, weekly, daily" });
    }
    const [person] = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("persons").where({ id: req.params.id }).update({ question_frequency: questionFrequency }).returning("question_frequency")
    );
    res.json({ questionFrequency: person.question_frequency });
  } catch (err) {
    next(err);
  }
});

// "Next adaptive question-stream prompt" — the adaptive, personalized-against-
// existing-memories selection described in the doc needs a real Claude call
// (src/services/claude.service.ts, still a stub). This is a simple
// placeholder selection (first bank question this person hasn't already
// answered) so the endpoint is usable end-to-end before that's wired up —
// intentionally not claiming to be the adaptive version yet.
collectionRouter.get("/persons/:id/question-prompt", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const question = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("interview_questions as q")
        .whereNotExists(
          trx("interview_answers as a")
            .join("interview_sessions as s", "s.id", "a.session_id")
            .whereRaw("a.question_id = q.id")
            .andWhere("s.person_id", req.params.id)
        )
        .orderBy("q.sort_order", "asc")
        .first()
    );
    if (!question) return res.json({ question: null });
    res.json({ question });
  } catch (err) {
    next(err);
  }
});

collectionRouter.post("/question-prompt/:id/answer", requireAuth, notImplemented(spec));

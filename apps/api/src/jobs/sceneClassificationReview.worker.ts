import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { classifyPhotoScene as defaultClassifyPhotoScene, PhotoClassificationResult } from "../services/claude.service";
import { ensureVisionCompatible } from "../services/imageNormalization.service";

export interface ReviewJobData {
  photoId: string;
}

export interface SceneClassificationReviewDeps {
  classify: (imageBytes: Buffer, labels: { label: string; confidence: number }[]) => Promise<PhotoClassificationResult>;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: SceneClassificationReviewDeps = { classify: defaultClassifyPhotoScene, getBytes: getObjectBuffer };

// Stage 2 — only ever enqueued (by sceneClassification.worker.ts) for
// photos stage 1 already flagged (docs/photo_pipeline_beta_architecture.md
// section 5). Confirms/vetoes with Claude Haiku and writes the caption,
// then — if confirmed — creates the proposed_memories row that's the actual
// user-facing suggestion (section 9). person_id there is the photo's
// uploader, the table's original, unchanged meaning.
export async function processReviewJob(data: ReviewJobData, deps: SceneClassificationReviewDeps = defaultDeps) {
  const { photoId } = data;
  const photo = await withServiceContext((trx) => trx("photos").where({ id: photoId }).first());
  if (!photo) throw new Error(`Photo ${photoId} not found`);
  const classification = await withServiceContext((trx) =>
    trx("photo_classifications").where({ photo_id: photoId }).first()
  );
  if (!classification) throw new Error(`No stage-1 classification exists yet for photo ${photoId}`);

  const rawBytes = await deps.getBytes(photo.r2_key);
  const imageBytes = await ensureVisionCompatible(rawBytes, photo.r2_key);
  const labels = (classification.labels ?? []) as { label: string; confidence: number }[];
  const result = await deps.classify(imageBytes, labels);

  await withServiceContext((trx) =>
    trx("photo_classifications").where({ photo_id: photoId }).update({
      is_candidate_worthy: result.isCandidateWorthy,
      suggested_caption: result.suggestedCaption,
      reviewed_at: new Date(),
    })
  );

  // 2026-07-19 fix — this half of the duplicate-proposal problem was missed
  // by the 2026-07-19 clustering-side fix (photoClustering.worker.ts
  // excludes photos with a pending individual proposal from its candidate
  // pool). That only guards one direction: it stops clustering from
  // re-proposing a photo classification already claimed, but nothing
  // stopped classification from claiming a photo clustering had *already*
  // swept up. Stage 2 (this job) runs on its own queue, independently timed
  // from face detection — the trigger for clustering's re-runs
  // (faceDetection.worker.ts) — and Claude Haiku round-trips are typically
  // slower than Rekognition DetectFaces, so a photo can easily land in a
  // cluster before its own classification even finishes. Symptom: the same
  // event showing up as both an "N photos from this outing" cluster card
  // and a separate single-photo captioned card for one of its own members.
  let proposalId: string | undefined;
  if (result.isCandidateWorthy) {
    const alreadyClustered = await withServiceContext((trx) =>
      trx("photo_cluster_photos").where({ photo_id: photoId }).first()
    );
    if (!alreadyClustered) {
      const [proposal] = await withServiceContext((trx) =>
        trx("proposed_memories").insert({ person_id: photo.uploaded_by, photo_id: photoId }).returning("id")
      );
      proposalId = proposal.id;
    }
  }

  return { photoId, isCandidateWorthy: result.isCandidateWorthy, proposalId };
}

export const sceneClassificationReviewWorker = new Worker(
  "scene-classification-review",
  async (job: Job<ReviewJobData>) => processReviewJob(job.data),
  { connection }
);

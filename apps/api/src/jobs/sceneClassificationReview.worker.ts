import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { classifyPhotoScene as defaultClassifyPhotoScene, PhotoClassificationResult } from "../services/claude.service";

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

  const imageBytes = await deps.getBytes(photo.r2_key);
  const labels = (classification.labels ?? []) as { label: string; confidence: number }[];
  const result = await deps.classify(imageBytes, labels);

  await withServiceContext((trx) =>
    trx("photo_classifications").where({ photo_id: photoId }).update({
      is_candidate_worthy: result.isCandidateWorthy,
      suggested_caption: result.suggestedCaption,
      reviewed_at: new Date(),
    })
  );

  let proposalId: string | undefined;
  if (result.isCandidateWorthy) {
    const [proposal] = await withServiceContext((trx) =>
      trx("proposed_memories").insert({ person_id: photo.uploaded_by, photo_id: photoId }).returning("id")
    );
    proposalId = proposal.id;
  }

  return { photoId, isCandidateWorthy: result.isCandidateWorthy, proposalId };
}

export const sceneClassificationReviewWorker = new Worker(
  "scene-classification-review",
  async (job: Job<ReviewJobData>) => processReviewJob(job.data),
  { connection }
);

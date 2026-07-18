import { Worker, Job } from "bullmq";
import { connection, sceneClassificationReviewQueue } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import {
  sceneLabelsService as defaultSceneLabelsService,
  SceneLabelsService,
  passesTriage,
} from "../services/sceneLabels.service";

export interface ClassifyJobData {
  photoId: string;
}

export interface SceneClassificationDeps {
  labels: SceneLabelsService;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: SceneClassificationDeps = { labels: defaultSceneLabelsService, getBytes: getObjectBuffer };

// Stage 1 (docs/photo_pipeline_beta_architecture.md section 5) — cheap
// triage across every synced photo via Rekognition DetectLabels. Only
// photos that pass the curated allowlist/confidence bar get enqueued for
// stage 2's more expensive Claude call — that split is the whole point of
// running this as two separate queues instead of one classifier doing both
// jobs.
export async function processClassifyJob(data: ClassifyJobData, deps: SceneClassificationDeps = defaultDeps) {
  const { photoId } = data;
  const photo = await withServiceContext((trx) => trx("photos").where({ id: photoId }).first());
  if (!photo) throw new Error(`Photo ${photoId} not found`);

  const imageBytes = await deps.getBytes(photo.r2_key);
  const labels = await deps.labels.detectLabels(imageBytes);
  const triagePassed = passesTriage(labels);

  await withServiceContext((trx) =>
    trx("photo_classifications")
      .insert({ photo_id: photoId, labels: JSON.stringify(labels), triage_passed: triagePassed })
      .onConflict("photo_id")
      .merge(["labels", "triage_passed"])
  );

  if (triagePassed) {
    await sceneClassificationReviewQueue.add("review", { photoId });
  }

  return { photoId, labelCount: labels.length, triagePassed };
}

export const sceneClassificationWorker = new Worker(
  "scene-classification",
  async (job: Job<ClassifyJobData>) => processClassifyJob(job.data),
  { connection }
);

import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { visionService as defaultVisionService, collectionIdFor, VisionService } from "../services/vision.service";
import { commitMatchedFace } from "./commitFaceMatch";

export interface DetectJobData {
  photoId: string;
}
export interface RemoveFromCollectionJobData {
  personId: string;
}

export interface FaceDetectionDeps {
  vision: VisionService;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: FaceDetectionDeps = { vision: defaultVisionService, getBytes: getObjectBuffer };

// docs/media_pipeline.md section 2. One SearchFacesByImage call per photo
// (rather than one per detected face box) is a deliberate simplification of
// the doc's per-face wording — Rekognition's SearchFacesByImage already
// matches every face it finds in the image against the collection in a
// single call, so this is the same result with fewer external calls.
export async function processDetectJob(data: DetectJobData, deps: FaceDetectionDeps = defaultDeps) {
  const { photoId } = data;
  const photo = await withServiceContext((trx) => trx("photos").where({ id: photoId }).first());
  if (!photo) throw new Error(`Photo ${photoId} not found`);

  const imageBytes = await deps.getBytes(photo.r2_key);
  const collectionId = collectionIdFor(photo.family_group_id);
  await deps.vision.ensureCollection(collectionId);

  const [faces, matches] = await Promise.all([
    deps.vision.detectFaces(imageBytes),
    deps.vision.searchFacesByImage(collectionId, imageBytes),
  ]);

  const matchedPersonIds: string[] = [];
  const createdMemories: string[] = [];
  const createdProposals: string[] = [];

  await withServiceContext(async (trx) => {
    for (const match of matches) {
      const person = await trx("persons").where({ id: match.externalImageId }).first();
      // Structurally shouldn't happen (only active persons are ever indexed —
      // see the vision.service.ts module doc comment) but defensive in case a
      // person was opted out after being indexed and before the collection
      // purge caught up.
      if (!person || person.status !== "active") continue;

      const result = await commitMatchedFace(trx, photo, person);
      matchedPersonIds.push(person.id);
      if (result.memoryId) createdMemories.push(result.memoryId);
      if (result.proposalId) createdProposals.push(result.proposalId);
    }
  });

  // Unmatched faces are deliberately not persisted anywhere (docs/media_pipeline.md
  // section 2 step 4: "nothing is written to photo_persons or any biometric
  // store") — they're only ever surfaced via this job's return value, for
  // whatever calls this synchronously (a manual-tag UI flow, in future).
  const unmatchedFaceCount = Math.max(0, faces.length - matches.length);
  return {
    photoId,
    facesDetected: faces.length,
    matched: matchedPersonIds.length,
    unmatchedFaceCount,
    createdMemories,
    createdProposals,
  };
}

// docs/media_pipeline.md section 4, "Permanent opt-out": face permanently
// excluded from the collection. photo_persons.face_blurred is already set by
// the route (invitations.routes.ts's /opt-out) before this job even runs —
// this only handles the biometric-store side.
export async function processRemoveFromCollectionJob(
  data: RemoveFromCollectionJobData,
  deps: FaceDetectionDeps = defaultDeps
) {
  const { personId } = data;
  const person = await withServiceContext((trx) => trx("persons").where({ id: personId }).first());
  if (!person) throw new Error(`Person ${personId} not found`);
  const collectionId = collectionIdFor(person.family_group_id);
  await deps.vision.deleteFaces(collectionId, personId);
}

export const faceDetectionWorker = new Worker(
  "face-detection",
  async (job: Job) => {
    if (job.name === "detect") return processDetectJob(job.data as DetectJobData);
    if (job.name === "remove-from-collection") return processRemoveFromCollectionJob(job.data as RemoveFromCollectionJobData);
    throw new Error(`Unknown face-detection job name: ${job.name}`);
  },
  { connection }
);

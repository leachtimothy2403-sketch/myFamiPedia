import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { visionService as defaultVisionService, collectionIdFor, VisionService } from "../services/vision.service";

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

// AUTOMATED MATCHING DISABLED (2026-07-18) — see
// docs/family_administrator_and_privacy_model.md section 5. Running
// SearchFacesByImage/IndexFaces against a biometric collection — including
// against non-family bystanders who never consented — is a real GDPR
// Article 9 exposure that hasn't been cleared by counsel. This worker now
// only calls DetectFaces (bounding boxes, no identity — not biometric
// identification data, no Article 9 exposure per the design doc). No
// matching, no collection writes, no auto-created memories or proposals.
// docs/media_pipeline.md section 2's SearchFacesByImage-based flow and
// commitFaceMatch.ts's tier-1/tier-2 branching are retired for the beta;
// they're left in place, unused, pending the manual tap-to-tag replacement
// (design doc sections 5-7) rather than deleted outright.
export async function processDetectJob(data: DetectJobData, deps: FaceDetectionDeps = defaultDeps) {
  const { photoId } = data;
  const photo = await withServiceContext((trx) => trx("photos").where({ id: photoId }).first());
  if (!photo) throw new Error(`Photo ${photoId} not found`);

  const imageBytes = await deps.getBytes(photo.r2_key);
  const faces = await deps.vision.detectFaces(imageBytes);

  // Detected face regions are deliberately not persisted anywhere yet —
  // they're only ever surfaced via this job's return value, for whatever
  // calls this synchronously (the manual tap-to-tag UI flow, not yet built).
  return {
    photoId,
    facesDetected: faces.length,
    matched: 0,
    unmatchedFaceCount: faces.length,
    createdMemories: [] as string[],
    createdProposals: [] as string[],
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

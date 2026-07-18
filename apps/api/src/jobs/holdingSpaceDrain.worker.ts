import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { visionService as defaultVisionService, VisionService } from "../services/vision.service";

export interface DrainJobData {
  personId: string;
}

export interface HoldingSpaceDrainDeps {
  vision: VisionService;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: HoldingSpaceDrainDeps = { vision: defaultVisionService, getBytes: getObjectBuffer };

// AUTOMATED MATCHING DISABLED (2026-07-18) — see
// docs/family_administrator_and_privacy_model.md section 5. This worker's
// original design enrolled a biometric face template from the person's own
// holding-space photos (IndexFaces) and retroactively ran SearchFacesByImage
// against the whole family's photo library — real GDPR Article 9 exposure,
// not cleared by counsel, disabled at the worker level so it can't go live
// just because someone wires up real AWS credentials later.
//
// KNOWN GAP, not silently papered over: this was the *only* mechanism that
// surfaced a photo-tag's content once the tagged person accepted their
// invitation (docs/media_pipeline.md section 3, "profile populates rapidly
// on acceptance"). Without matching, there's no way yet to know which of the
// family's other photos this person appears in, and the originally-tagged
// holding_space photo itself was only ever going to be found again by that
// same retroactive scan. So: holding_space rows are deliberately left
// un-archived here (not drained, not discarded) rather than marking them
// processed and losing the content. This needs a real replacement — probably
// draining each holding_space photo directly into a manual tap-to-tag review
// card for the newly-active person, rather than relying on rediscovery via
// matching — as part of the photo-pipeline rebuild (design doc sections 5-7).
export async function processDrainJob(data: DrainJobData, deps: HoldingSpaceDrainDeps = defaultDeps) {
  const { personId } = data;
  const person = await withServiceContext((trx) => trx("persons").where({ id: personId }).first());
  if (!person) throw new Error(`Person ${personId} not found`);

  const holdingRows = await withServiceContext((trx) =>
    trx("holding_space").where({ person_id: personId }).whereNull("archived_at")
  );

  return { personId, enrolledFromHoldingSpace: 0, newlyMatchedPhotoIds: [] as string[], pendingHoldingSpaceRows: holdingRows.length };
}

export const holdingSpaceDrainWorker = new Worker(
  "holding-space-drain",
  async (job: Job<DrainJobData>) => processDrainJob(job.data),
  { connection }
);

import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { visionService as defaultVisionService, collectionIdFor, VisionService } from "../services/vision.service";
import { commitMatchedFace } from "./commitFaceMatch";

export interface DrainJobData {
  personId: string;
}

export interface HoldingSpaceDrainDeps {
  vision: VisionService;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: HoldingSpaceDrainDeps = { vision: defaultVisionService, getBytes: getObjectBuffer };

// docs/media_pipeline.md section 3, the "profile populates rapidly on
// acceptance" behavior. Runs once, triggered by invitations.routes.ts's
// POST /invitations/:token/accept. Not part of the original scaffold's
// stub set (that predates the holding_space table's drain design) —
// unlike its siblings in this directory, there's no earlier "Not
// implemented" placeholder this replaces.
export async function processDrainJob(data: DrainJobData, deps: HoldingSpaceDrainDeps = defaultDeps) {
  const { personId } = data;
  const person = await withServiceContext((trx) => trx("persons").where({ id: personId }).first());
  if (!person) throw new Error(`Person ${personId} not found`);
  const collectionId = collectionIdFor(person.family_group_id);
  await deps.vision.ensureCollection(collectionId);

  const holdingRows = await withServiceContext((trx) =>
    trx("holding_space").where({ person_id: personId }).whereNull("archived_at")
  );

  // Step 1: enroll this person's face using every tagged photo sitting in
  // their holding space as training input. Voice/mention rows have nothing
  // to enroll — only photo rows go through the vision service here.
  for (const row of holdingRows.filter((r: { media_type: string }) => r.media_type === "photo")) {
    if (!row.r2_key) continue;
    const bytes = await deps.getBytes(row.r2_key);
    await deps.vision.indexFace(collectionId, bytes, personId);
  }

  // Step 2: retroactively re-run SearchFacesByImage across every photo in the
  // family that isn't already linked to this person, now that their face
  // template actually exists in the collection.
  const candidatePhotos = await withServiceContext((trx) =>
    trx("photos")
      .where({ family_group_id: person.family_group_id })
      .whereNotExists(
        trx("photo_persons").whereRaw("photo_persons.photo_id = photos.id").andWhere("photo_persons.person_id", personId)
      )
  );

  const newlyMatchedPhotoIds: string[] = [];
  for (const photo of candidatePhotos) {
    const bytes = await deps.getBytes(photo.r2_key);
    const matches = await deps.vision.searchFacesByImage(collectionId, bytes);
    if (!matches.some((m) => m.externalImageId === personId)) continue;
    await withServiceContext((trx) => commitMatchedFace(trx, photo, person));
    newlyMatchedPhotoIds.push(photo.id);
  }

  // Step 3: archive (not delete) every holding_space row for this person,
  // regardless of media_type — kept for provenance per the doc.
  await withServiceContext((trx) =>
    trx("holding_space").where({ person_id: personId }).whereNull("archived_at").update({ archived_at: new Date() })
  );

  return { personId, enrolledFromHoldingSpace: holdingRows.length, newlyMatchedPhotoIds };
}

export const holdingSpaceDrainWorker = new Worker(
  "holding-space-drain",
  async (job: Job<DrainJobData>) => processDrainJob(job.data),
  { connection }
);

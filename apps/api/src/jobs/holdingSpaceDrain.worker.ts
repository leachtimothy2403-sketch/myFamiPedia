import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";

export interface DrainJobData {
  personId: string;
}

// docs/photo_pipeline_beta_architecture.md section 10 — the redesign that
// replaces today's (2026-07-18) stopgap, which left holding_space rows
// un-archived because the old drain mechanism (biometric enrollment +
// retroactive re-scan) was disabled outright. That retroactive rediscovery
// turns out not to be needed: every holding_space row written by the
// current tap-to-tag flow (photos.routes.ts branch (b), and the
// proposal-approval endpoint) already carries the exact photoId/faceId/
// faceCoordinates it needs in raw_metadata, because a human supplied them
// at tag time — there's nothing left to "discover." Draining is now a
// straight promotion: no matching, no re-scan, no vision service involved
// at all.
export async function processDrainJob(data: DrainJobData) {
  const { personId } = data;
  const person = await withServiceContext((trx) => trx("persons").where({ id: personId }).first());
  if (!person) throw new Error(`Person ${personId} not found`);

  const holdingRows = await withServiceContext((trx) =>
    trx("holding_space").where({ person_id: personId }).whereNull("archived_at")
  );

  let photosPromoted = 0;
  let mentionsPromoted = 0;

  for (const row of holdingRows) {
    const meta = (row.raw_metadata ?? {}) as {
      photoId?: string;
      faceId?: string;
      faceCoordinates?: unknown;
      memoryId?: string;
    };

    if (row.media_type === "photo" && meta.photoId && meta.faceId) {
      await withServiceContext(async (trx) => {
        await trx("photo_persons")
          .insert({
            photo_id: meta.photoId,
            person_id: personId,
            face_coordinates: JSON.stringify(meta.faceCoordinates ?? null),
            identification_status: "confirmed",
            face_id: meta.faceId,
            tagged_by: row.source_person_id,
          })
          .onConflict(["photo_id", "person_id"])
          .ignore();

        if (meta.memoryId) {
          const memory = await trx("memories").where({ id: meta.memoryId }).first();
          if (memory) {
            await trx("memory_persons")
              .insert({ memory_id: meta.memoryId, person_id: personId })
              .onConflict(["memory_id", "person_id"])
              .ignore();
            await trx("memory_photos")
              .insert({ memory_id: meta.memoryId, photo_id: meta.photoId })
              .onConflict(["memory_id", "photo_id"])
              .ignore();
          }
        }
      });
      photosPromoted++;
    } else if (row.media_type === "mention" && meta.memoryId) {
      await withServiceContext(async (trx) => {
        const memory = await trx("memories").where({ id: meta.memoryId }).first();
        if (memory) {
          await trx("memory_persons")
            .insert({ memory_id: meta.memoryId, person_id: personId })
            .onConflict(["memory_id", "person_id"])
            .ignore();
        }
      });
      mentionsPromoted++;
    }
    // media_type === 'voice' (or a photo/mention row missing the metadata a
    // human tag should always have supplied) has no promotion step defined
    // here — archived below for provenance like everything else, but not
    // acted on. Voice-consent holding is a separate concern from this
    // pipeline; see docs/media_pipeline.md.

    await withServiceContext((trx) => trx("holding_space").where({ id: row.id }).update({ archived_at: new Date() }));
  }

  return { personId, photosPromoted, mentionsPromoted, archived: holdingRows.length };
}

export const holdingSpaceDrainWorker = new Worker(
  "holding-space-drain",
  async (job: Job<DrainJobData>) => processDrainJob(job.data),
  { connection }
);

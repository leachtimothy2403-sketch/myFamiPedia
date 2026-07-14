import type { Knex } from "knex";

// Shared by faceDetection.worker.ts (fresh camera-roll photos) and
// holdingSpaceDrain.worker.ts (retroactive scan on acceptance) — both need
// the exact same tier-1-auto-commit vs tier-2/3-propose branch from
// docs/media_pipeline.md section 2 step 3, and it's important they stay in
// sync rather than drifting into two slightly different implementations.
export async function commitMatchedFace(
  trx: Knex.Transaction,
  photo: { id: string; family_group_id: string; uploaded_by: string },
  person: { id: string; privacy_tier: number | null }
): Promise<{ memoryId?: string; proposalId?: string }> {
  await trx("photo_persons")
    .insert({ photo_id: photo.id, person_id: person.id, identification_status: "auto_matched" })
    .onConflict(["photo_id", "person_id"])
    .merge();

  if (person.privacy_tier === 1) {
    const [memory] = await trx("memories")
      .insert({
        family_group_id: photo.family_group_id,
        contributor_id: photo.uploaded_by,
        provenance_type: "photo",
        media_url: null,
      })
      .returning("id");
    await trx("memory_persons").insert({ memory_id: memory.id, person_id: person.id });
    await trx("memory_photos").insert({ memory_id: memory.id, photo_id: photo.id });
    return { memoryId: memory.id };
  }

  const [proposal] = await trx("proposed_memories").insert({ person_id: person.id, photo_id: photo.id }).returning("id");
  return { proposalId: proposal.id };
}

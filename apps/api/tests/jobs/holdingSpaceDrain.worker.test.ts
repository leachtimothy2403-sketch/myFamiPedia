import { describe, it, expect } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

// docs/photo_pipeline_beta_architecture.md section 10 — draining is now a
// straight promotion of data a human already supplied at tag time, no
// matching, no vision service, no re-scan of the family's photo library.
describe("holding-space-drain worker (redesigned, no matching)", () => {
  const ctx = withDb();

  async function seedFamily() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [tagger] = await knex("persons").insert({ family_group_id: group.id, name: "Tagger", status: "active" }).returning("*");
    const [subject] = await knex("persons").insert({ family_group_id: group.id, name: "Newly Accepted", status: "active" }).returning("*");
    const [photo] = await knex("photos").insert({ family_group_id: group.id, r2_key: "photos/1.jpg", uploaded_by: tagger.id }).returning("*");
    const [face] = await knex("photo_faces").insert({ photo_id: photo.id, face_coordinates: JSON.stringify({ left: 0.1, top: 0.1, width: 0.2, height: 0.2 }), confidence: 98 }).returning("*");
    return { group, tagger, subject, photo, face };
  }

  it("promotes a photo holding_space row into photo_persons, no matching involved", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    const knex = ctx.knex();
    const { tagger, subject, photo, face } = await seedFamily();

    const [holdingRow] = await knex("holding_space")
      .insert({
        person_id: subject.id,
        source_person_id: tagger.id,
        media_type: "photo",
        r2_key: photo.r2_key,
        raw_metadata: JSON.stringify({ photoId: photo.id, faceId: face.id, faceCoordinates: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 } }),
      })
      .returning("*");

    const result = await processDrainJob({ personId: subject.id });

    expect(result.photosPromoted).toBe(1);
    expect(result.archived).toBe(1);

    const tag = await knex("photo_persons").where({ photo_id: photo.id, person_id: subject.id }).first();
    expect(tag).toBeDefined();
    expect(tag.identification_status).toBe("confirmed");
    expect(tag.face_id).toBe(face.id);
    expect(tag.tagged_by).toBe(tagger.id);

    const refreshed = await knex("holding_space").where({ id: holdingRow.id }).first();
    expect(refreshed.archived_at).not.toBeNull();
  });

  it("also attaches memory_persons/memory_photos when the held tag carries a memoryId", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    const knex = ctx.knex();
    const { tagger, subject, photo, face } = await seedFamily();

    const [memory] = await knex("memories")
      .insert({ family_group_id: (await knex("persons").where({ id: subject.id }).first()).family_group_id, contributor_id: tagger.id, content: "A day out", provenance_type: "photo" })
      .returning("*");

    await knex("holding_space").insert({
      person_id: subject.id,
      source_person_id: tagger.id,
      media_type: "photo",
      r2_key: photo.r2_key,
      raw_metadata: JSON.stringify({ photoId: photo.id, faceId: face.id, faceCoordinates: {}, memoryId: memory.id }),
    });

    await processDrainJob({ personId: subject.id });

    const link = await knex("memory_persons").where({ memory_id: memory.id, person_id: subject.id }).first();
    expect(link).toBeDefined();
    const photoLink = await knex("memory_photos").where({ memory_id: memory.id, photo_id: photo.id }).first();
    expect(photoLink).toBeDefined();
  });

  it("promotes a mention holding_space row into memory_persons", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    const knex = ctx.knex();
    const { tagger, subject } = await seedFamily();
    const group = await knex("persons").where({ id: subject.id }).first();

    const [memory] = await knex("memories")
      .insert({ family_group_id: group.family_group_id, contributor_id: tagger.id, content: "Boat trip with Marc and Aunt Sophie", provenance_type: "text" })
      .returning("*");

    await knex("holding_space").insert({
      person_id: subject.id,
      source_person_id: tagger.id,
      media_type: "mention",
      raw_metadata: JSON.stringify({ memoryId: memory.id }),
    });

    const result = await processDrainJob({ personId: subject.id });

    expect(result.mentionsPromoted).toBe(1);
    const link = await knex("memory_persons").where({ memory_id: memory.id, person_id: subject.id }).first();
    expect(link).toBeDefined();
  });

  it("archives rows it can't act on (e.g. missing metadata) without throwing", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    const knex = ctx.knex();
    const { tagger, subject } = await seedFamily();

    const [holdingRow] = await knex("holding_space")
      .insert({ person_id: subject.id, source_person_id: tagger.id, media_type: "voice" })
      .returning("*");

    const result = await processDrainJob({ personId: subject.id });

    expect(result.photosPromoted).toBe(0);
    expect(result.mentionsPromoted).toBe(0);
    expect(result.archived).toBe(1);
    const refreshed = await knex("holding_space").where({ id: holdingRow.id }).first();
    expect(refreshed.archived_at).not.toBeNull();
  });

  it("throws for an unknown person", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    await expect(processDrainJob({ personId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow();
  });
});

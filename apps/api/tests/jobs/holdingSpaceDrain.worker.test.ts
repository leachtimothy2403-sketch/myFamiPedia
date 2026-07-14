import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();
import type { VisionService, FaceMatch } from "../../src/services/vision.service";

function fakeVision(overrides: Partial<VisionService> = {}): VisionService {
  return {
    ensureCollection: vi.fn(async () => {}),
    detectFaces: vi.fn(async () => []),
    searchFacesByImage: vi.fn(async (): Promise<FaceMatch[]> => []),
    indexFace: vi.fn(async () => {}),
    deleteFaces: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("holding-space-drain worker", () => {
  const ctx = withDb();

  it("enrolls from holding-space photos, retroactively matches existing family photos, and archives holding_space rows", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    const knex = ctx.knex();

    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [subject] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Newly Accepted", status: "active" })
      .returning("*");
    const [inviter] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Inviter", status: "active" })
      .returning("*");

    const [holdingRow] = await knex("holding_space")
      .insert({
        person_id: subject.id,
        source_person_id: inviter.id,
        media_type: "photo",
        r2_key: "holding/subject/1.jpg",
      })
      .returning("*");

    // A pre-existing family photo the subject appears in but was never tagged.
    const [candidatePhoto] = await knex("photos")
      .insert({ family_group_id: group.id, r2_key: "photos/old.jpg", uploaded_by: inviter.id })
      .returning("*");

    const indexFace = vi.fn(async () => {});
    const searchFacesByImage = vi.fn(async (_collectionId: string, _bytes: Buffer) => [
      { externalImageId: subject.id, similarity: 97 },
    ]);
    const vision = fakeVision({ indexFace, searchFacesByImage });
    const getBytes = vi.fn(async () => Buffer.from("fake-bytes"));

    const result = await processDrainJob({ personId: subject.id }, { vision, getBytes });

    expect(indexFace).toHaveBeenCalledWith(`myfamipedia-${group.id}`, expect.any(Buffer), subject.id);
    expect(result.newlyMatchedPhotoIds).toContain(candidatePhoto.id);

    const photoPersons = await knex("photo_persons").where({ photo_id: candidatePhoto.id, person_id: subject.id });
    expect(photoPersons).toHaveLength(1);

    const refreshedHolding = await knex("holding_space").where({ id: holdingRow.id }).first();
    expect(refreshedHolding.archived_at).not.toBeNull();
  });

  it("does not re-match a photo the subject is already linked to", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    const knex = ctx.knex();

    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [subject] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Subject", status: "active" })
      .returning("*");
    const [photo] = await knex("photos")
      .insert({ family_group_id: group.id, r2_key: "photos/already-tagged.jpg", uploaded_by: subject.id })
      .returning("*");
    await knex("photo_persons").insert({ photo_id: photo.id, person_id: subject.id, identification_status: "confirmed" });

    const searchFacesByImage = vi.fn(async () => [{ externalImageId: subject.id, similarity: 99 }]);
    const vision = fakeVision({ searchFacesByImage });
    const getBytes = vi.fn(async () => Buffer.from(""));

    await processDrainJob({ personId: subject.id }, { vision, getBytes });

    // whereNotExists should have excluded this photo from the retroactive scan entirely
    expect(searchFacesByImage).not.toHaveBeenCalled();
  });
});

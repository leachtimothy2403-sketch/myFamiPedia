import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();
import type { VisionService, FaceBox, FaceMatch } from "../../src/services/vision.service";

function fakeVision(overrides: Partial<VisionService> = {}): VisionService {
  return {
    ensureCollection: vi.fn(async () => {}),
    detectFaces: vi.fn(async (): Promise<FaceBox[]> => []),
    searchFacesByImage: vi.fn(async (): Promise<FaceMatch[]> => []),
    indexFace: vi.fn(async () => {}),
    deleteFaces: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("face-detection worker", () => {
  const ctx = withDb();

  async function seedFamily() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [contributor] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Uploader", status: "active" })
      .returning("*");
    const [tier1Person] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Tier1 Person", status: "active", privacy_tier: 1 })
      .returning("*");
    const [tier2Person] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Tier2 Person", status: "active", privacy_tier: 2 })
      .returning("*");
    const [photo] = await knex("photos")
      .insert({ family_group_id: group.id, r2_key: "photos/1.jpg", uploaded_by: contributor.id })
      .returning("*");
    return { group, contributor, tier1Person, tier2Person, photo };
  }

  it("auto-commits a memory for a tier-1 match and proposes one for a tier-2/3 match", async () => {
    const { processDetectJob } = await import("../../src/jobs/faceDetection.worker");
    const { tier1Person, tier2Person, photo } = await seedFamily();

    const vision = fakeVision({
      detectFaces: vi.fn(async () => [{ boundingBox: { width: 1, height: 1, left: 0, top: 0 }, confidence: 99 }, { boundingBox: { width: 1, height: 1, left: 0, top: 0 }, confidence: 98 }]),
      searchFacesByImage: vi.fn(async () => [
        { externalImageId: tier1Person.id, similarity: 99 },
        { externalImageId: tier2Person.id, similarity: 95 },
      ]),
    });
    const getBytes = vi.fn(async () => Buffer.from("fake-image-bytes"));

    const result = await processDetectJob({ photoId: photo.id }, { vision, getBytes });

    expect(result.matched).toBe(2);
    expect(result.unmatchedFaceCount).toBe(0);
    expect(result.createdMemories).toHaveLength(1);
    expect(result.createdProposals).toHaveLength(1);

    const knex = ctx.knex();
    const photoPersons = await knex("photo_persons").where({ photo_id: photo.id }).orderBy("person_id");
    expect(photoPersons).toHaveLength(2);
    expect(photoPersons.every((pp: { identification_status: string }) => pp.identification_status === "auto_matched")).toBe(true);

    const tier1Memory = await knex("memories").where({ family_group_id: photo.family_group_id });
    expect(tier1Memory).toHaveLength(1);
    expect(tier1Memory[0].provenance_type).toBe("photo");

    const proposals = await knex("proposed_memories").where({ person_id: tier2Person.id });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].photo_id).toBe(photo.id);
  });

  it("does not write anything for unmatched faces, and reports them in the return value", async () => {
    const { processDetectJob } = await import("../../src/jobs/faceDetection.worker");
    const { photo } = await seedFamily();

    const vision = fakeVision({
      detectFaces: vi.fn(async () => [{ boundingBox: { width: 1, height: 1, left: 0, top: 0 }, confidence: 90 }]),
      searchFacesByImage: vi.fn(async () => []),
    });
    const getBytes = vi.fn(async () => Buffer.from("fake-image-bytes"));

    const result = await processDetectJob({ photoId: photo.id }, { vision, getBytes });

    expect(result.matched).toBe(0);
    expect(result.unmatchedFaceCount).toBe(1);
    const photoPersons = await ctx.knex()("photo_persons").where({ photo_id: photo.id });
    expect(photoPersons).toHaveLength(0);
  });

  it("remove-from-collection calls deleteFaces against the person's family collection", async () => {
    const { processRemoveFromCollectionJob } = await import("../../src/jobs/faceDetection.worker");
    const { tier1Person } = await seedFamily();

    const deleteFaces = vi.fn(async () => {});
    const vision = fakeVision({ deleteFaces });
    const getBytes = vi.fn(async () => Buffer.from(""));

    await processRemoveFromCollectionJob({ personId: tier1Person.id }, { vision, getBytes });

    expect(deleteFaces).toHaveBeenCalledWith(`myfamipedia-${tier1Person.family_group_id}`, tier1Person.id);
  });
});

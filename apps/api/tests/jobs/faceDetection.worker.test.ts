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

  // Automated matching is disabled (see the worker's header comment and
  // docs/family_administrator_and_privacy_model.md section 5) — detection
  // never triggers a search, so no memory or proposal gets auto-created
  // regardless of the matched persons' privacy_tier. These tests assert the
  // worker doesn't even attempt to call searchFacesByImage anymore.
  it("only detects faces — does not search, match, or write anything, even with matching persons in the family", async () => {
    const { processDetectJob } = await import("../../src/jobs/faceDetection.worker");
    const { photo } = await seedFamily();

    const searchFacesByImage = vi.fn(async (): Promise<FaceMatch[]> => []);
    const vision = fakeVision({
      detectFaces: vi.fn(async () => [
        { boundingBox: { width: 1, height: 1, left: 0, top: 0 }, confidence: 99 },
        { boundingBox: { width: 1, height: 1, left: 0, top: 0 }, confidence: 98 },
      ]),
      searchFacesByImage,
    });
    const getBytes = vi.fn(async () => Buffer.from("fake-image-bytes"));

    const result = await processDetectJob({ photoId: photo.id }, { vision, getBytes });

    expect(searchFacesByImage).not.toHaveBeenCalled();
    expect(result.matched).toBe(0);
    expect(result.unmatchedFaceCount).toBe(2);
    expect(result.createdMemories).toHaveLength(0);
    expect(result.createdProposals).toHaveLength(0);

    const knex = ctx.knex();
    const photoPersons = await knex("photo_persons").where({ photo_id: photo.id });
    expect(photoPersons).toHaveLength(0);
    const memories = await knex("memories").where({ family_group_id: photo.family_group_id });
    expect(memories).toHaveLength(0);
    const proposals = await knex("proposed_memories");
    expect(proposals).toHaveLength(0);
  });

  it("persists detected faces to photo_faces and denormalizes photos.face_count", async () => {
    const { processDetectJob } = await import("../../src/jobs/faceDetection.worker");
    const { photo } = await seedFamily();

    const vision = fakeVision({
      detectFaces: vi.fn(async () => [
        { boundingBox: { width: 0.2, height: 0.3, left: 0.1, top: 0.1 }, confidence: 99 },
        { boundingBox: { width: 0.2, height: 0.3, left: 0.5, top: 0.1 }, confidence: 90 },
      ]),
    });
    const getBytes = vi.fn(async () => Buffer.from("fake-image-bytes"));

    const result = await processDetectJob({ photoId: photo.id }, { vision, getBytes });

    expect(result.facesDetected).toBe(2);
    expect(result.faceIds).toHaveLength(2);
    expect(result.matched).toBe(0);
    expect(result.unmatchedFaceCount).toBe(2);

    const knex = ctx.knex();
    const faceRows = await knex("photo_faces").where({ photo_id: photo.id }).orderBy("confidence", "desc");
    expect(faceRows).toHaveLength(2);
    expect(Number(faceRows[0].confidence)).toBe(99);
    expect(faceRows[0].face_coordinates).toEqual({ width: 0.2, height: 0.3, left: 0.1, top: 0.1 });

    const updatedPhoto = await knex("photos").where({ id: photo.id }).first();
    expect(updatedPhoto.face_count).toBe(2);

    const photoPersons = await knex("photo_persons").where({ photo_id: photo.id });
    expect(photoPersons).toHaveLength(0);
  });

  it("sets face_count to 0 and writes no rows when no faces are detected", async () => {
    const { processDetectJob } = await import("../../src/jobs/faceDetection.worker");
    const { photo } = await seedFamily();

    const vision = fakeVision({ detectFaces: vi.fn(async () => []) });
    const getBytes = vi.fn(async () => Buffer.from("fake-image-bytes"));

    const result = await processDetectJob({ photoId: photo.id }, { vision, getBytes });

    expect(result.facesDetected).toBe(0);
    expect(result.faceIds).toHaveLength(0);
    const knex = ctx.knex();
    expect((await knex("photo_faces").where({ photo_id: photo.id })).length).toBe(0);
    expect((await knex("photos").where({ id: photo.id }).first()).face_count).toBe(0);
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

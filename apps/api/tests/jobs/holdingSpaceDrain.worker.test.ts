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

// Automated matching/enrollment is disabled (see the worker's header comment
// and docs/family_administrator_and_privacy_model.md section 5) — this
// worker no longer calls indexFace or searchFacesByImage, and deliberately
// leaves holding_space rows un-archived rather than draining them via a
// mechanism (retroactive matching) that no longer runs. That's a known,
// documented gap pending the photo-pipeline rebuild, not a bug.
describe("holding-space-drain worker", () => {
  const ctx = withDb();

  it("does not enroll or search, and leaves holding_space rows un-archived", async () => {
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
    await knex("photos").insert({ family_group_id: group.id, r2_key: "photos/old.jpg", uploaded_by: inviter.id }).returning("*");

    const indexFace = vi.fn(async () => {});
    const searchFacesByImage = vi.fn(async (): Promise<FaceMatch[]> => [{ externalImageId: subject.id, similarity: 97 }]);
    const vision = fakeVision({ indexFace, searchFacesByImage });
    const getBytes = vi.fn(async () => Buffer.from("fake-bytes"));

    const result = await processDrainJob({ personId: subject.id }, { vision, getBytes });

    expect(indexFace).not.toHaveBeenCalled();
    expect(searchFacesByImage).not.toHaveBeenCalled();
    expect(result.newlyMatchedPhotoIds).toHaveLength(0);
    expect(result.pendingHoldingSpaceRows).toBe(1);

    const refreshedHolding = await knex("holding_space").where({ id: holdingRow.id }).first();
    expect(refreshedHolding.archived_at).toBeNull();
  });

  it("reports zero pending rows when there's nothing in holding_space for the person", async () => {
    const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
    const knex = ctx.knex();

    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [subject] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Subject", status: "active" })
      .returning("*");

    const vision = fakeVision();
    const getBytes = vi.fn(async () => Buffer.from(""));

    const result = await processDrainJob({ personId: subject.id }, { vision, getBytes });

    expect(result.pendingHoldingSpaceRows).toBe(0);
  });
});

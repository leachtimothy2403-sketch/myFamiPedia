import { describe, it, expect, vi, beforeEach } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();
import type { SceneLabelsService, SceneLabel } from "../../src/services/sceneLabels.service";

function fakeLabelsService(labels: SceneLabel[]): SceneLabelsService {
  return { detectLabels: vi.fn(async () => labels) };
}

describe("scene-classification worker (stage 1)", () => {
  const ctx = withDb();

  beforeEach(async () => {
    // The queue mock's spies live for the whole file (mockQueues() only
    // installs them once), not per-test — clear call history so one test's
    // enqueue doesn't leak into the next one's assertion.
    await import("../../src/jobs/queue");
    getQueueMock("sceneClassificationReviewQueue").add.mockClear();
  });

  async function seedPhoto() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [contributor] = await knex("persons").insert({ family_group_id: group.id, name: "Uploader", status: "active" }).returning("*");
    const [photo] = await knex("photos")
      .insert({ family_group_id: group.id, r2_key: "photos/1.jpg", uploaded_by: contributor.id })
      .returning("*");
    return { group, contributor, photo };
  }

  it("persists labels + triage_passed=true and enqueues stage 2 when an allowlisted label clears the confidence bar", async () => {
    const { processClassifyJob } = await import("../../src/jobs/sceneClassification.worker");
    const { photo } = await seedPhoto();

    const labels: SceneLabel[] = [{ label: "Birthday", confidence: 92 }, { label: "Cake", confidence: 88 }];
    const result = await processClassifyJob(
      { photoId: photo.id },
      { labels: fakeLabelsService(labels), getBytes: vi.fn(async () => Buffer.from("x")) }
    );

    expect(result.triagePassed).toBe(true);
    expect(result.labelCount).toBe(2);

    const knex = ctx.knex();
    const row = await knex("photo_classifications").where({ photo_id: photo.id }).first();
    expect(row.triage_passed).toBe(true);
    expect(row.labels).toEqual(labels);
    expect(row.reviewed_at).toBeNull();

    expect(getQueueMock("sceneClassificationReviewQueue").add).toHaveBeenCalledTimes(1);
    expect(getQueueMock("sceneClassificationReviewQueue").add).toHaveBeenCalledWith("review", { photoId: photo.id });
  });

  it("persists triage_passed=false and does not enqueue stage 2 when nothing clears the bar", async () => {
    const { processClassifyJob } = await import("../../src/jobs/sceneClassification.worker");
    const { photo } = await seedPhoto();

    const labels: SceneLabel[] = [{ label: "Sky", confidence: 99 }, { label: "Birthday", confidence: 40 }];
    const result = await processClassifyJob(
      { photoId: photo.id },
      { labels: fakeLabelsService(labels), getBytes: vi.fn(async () => Buffer.from("x")) }
    );

    expect(result.triagePassed).toBe(false);
    const knex = ctx.knex();
    const row = await knex("photo_classifications").where({ photo_id: photo.id }).first();
    expect(row.triage_passed).toBe(false);
    expect(getQueueMock("sceneClassificationReviewQueue").add).not.toHaveBeenCalled();
  });

  it("throws for an unknown photo", async () => {
    const { processClassifyJob } = await import("../../src/jobs/sceneClassification.worker");
    await expect(
      processClassifyJob(
        { photoId: "00000000-0000-0000-0000-000000000000" },
        { labels: fakeLabelsService([]), getBytes: vi.fn(async () => Buffer.from("x")) }
      )
    ).rejects.toThrow();
  });
});

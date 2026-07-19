import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();
import type { PhotoClassificationResult } from "../../src/services/claude.service";

describe("scene-classification-review worker (stage 2)", () => {
  const ctx = withDb();

  async function seedClassifiedPhoto(triagePassed = true) {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [contributor] = await knex("persons").insert({ family_group_id: group.id, name: "Uploader", status: "active" }).returning("*");
    const [photo] = await knex("photos")
      .insert({ family_group_id: group.id, r2_key: "photos/1.jpg", uploaded_by: contributor.id })
      .returning("*");
    await knex("photo_classifications").insert({
      photo_id: photo.id,
      labels: JSON.stringify([{ label: "Birthday", confidence: 92 }]),
      triage_passed: triagePassed,
    });
    return { group, contributor, photo };
  }

  it("confirms a candidate: writes the caption/verdict and creates a proposed_memories row keyed to the uploader", async () => {
    const { processReviewJob } = await import("../../src/jobs/sceneClassificationReview.worker");
    const { photo, contributor } = await seedClassifiedPhoto();

    const classify = vi.fn(async (): Promise<PhotoClassificationResult> => ({
      isCandidateWorthy: true,
      suggestedCaption: "A birthday celebration",
    }));
    const result = await processReviewJob({ photoId: photo.id }, { classify, getBytes: vi.fn(async () => Buffer.from("x")) });

    expect(result.isCandidateWorthy).toBe(true);
    expect(result.proposalId).toBeDefined();

    const knex = ctx.knex();
    const classification = await knex("photo_classifications").where({ photo_id: photo.id }).first();
    expect(classification.is_candidate_worthy).toBe(true);
    expect(classification.suggested_caption).toBe("A birthday celebration");
    expect(classification.reviewed_at).not.toBeNull();

    const proposals = await knex("proposed_memories").where({ photo_id: photo.id });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].person_id).toBe(contributor.id);
    expect(proposals[0].cluster_id).toBeNull();
  });

  it("vetoes a candidate: writes the verdict but creates no proposed_memories row", async () => {
    const { processReviewJob } = await import("../../src/jobs/sceneClassificationReview.worker");
    const { photo } = await seedClassifiedPhoto();

    const classify = vi.fn(async (): Promise<PhotoClassificationResult> => ({ isCandidateWorthy: false, suggestedCaption: null }));
    const result = await processReviewJob({ photoId: photo.id }, { classify, getBytes: vi.fn(async () => Buffer.from("x")) });

    expect(result.isCandidateWorthy).toBe(false);
    expect(result.proposalId).toBeUndefined();

    const knex = ctx.knex();
    const proposals = await knex("proposed_memories").where({ photo_id: photo.id });
    expect(proposals).toHaveLength(0);
  });

  // 2026-07-19 fix — the reverse direction of the duplicate-proposal bug.
  // photoClustering.worker.ts already excludes photos with a pending
  // individual proposal from its candidate pool, but nothing stopped this
  // job from proposing a photo clustering had already claimed — plausible
  // in practice since face detection (clustering's trigger) and Claude
  // Haiku classification (this job) run on independently-timed queues.
  it("does not create a duplicate individual proposal for a photo already swept into a cluster", async () => {
    const { processReviewJob } = await import("../../src/jobs/sceneClassificationReview.worker");
    const { photo, group } = await seedClassifiedPhoto();

    const knex = ctx.knex();
    const [cluster] = await knex("photo_clusters").insert({ family_group_id: group.id }).returning("*");
    await knex("photo_cluster_photos").insert({ cluster_id: cluster.id, photo_id: photo.id });

    const classify = vi.fn(async (): Promise<PhotoClassificationResult> => ({
      isCandidateWorthy: true,
      suggestedCaption: "A birthday celebration",
    }));
    const result = await processReviewJob({ photoId: photo.id }, { classify, getBytes: vi.fn(async () => Buffer.from("x")) });

    // The verdict/caption still get written — only the duplicate proposal is skipped.
    expect(result.isCandidateWorthy).toBe(true);
    expect(result.proposalId).toBeUndefined();

    const classification = await knex("photo_classifications").where({ photo_id: photo.id }).first();
    expect(classification.is_candidate_worthy).toBe(true);
    expect(classification.suggested_caption).toBe("A birthday celebration");

    const proposals = await knex("proposed_memories").where({ photo_id: photo.id });
    expect(proposals).toHaveLength(0);
  });

  it("throws if stage 1 hasn't run yet for this photo", async () => {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [contributor] = await knex("persons").insert({ family_group_id: group.id, name: "Uploader", status: "active" }).returning("*");
    const [photo] = await knex("photos")
      .insert({ family_group_id: group.id, r2_key: "photos/1.jpg", uploaded_by: contributor.id })
      .returning("*");

    const { processReviewJob } = await import("../../src/jobs/sceneClassificationReview.worker");
    const classify = vi.fn(async (): Promise<PhotoClassificationResult> => ({ isCandidateWorthy: true, suggestedCaption: "x" }));
    await expect(
      processReviewJob({ photoId: photo.id }, { classify, getBytes: vi.fn(async () => Buffer.from("x")) })
    ).rejects.toThrow(/stage-1/);
  });
});

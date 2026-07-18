import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

describe("collection", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  describe("camera-roll sync", () => {
    it("registers photos and enqueues face detection, scene classification, and one clustering pass per sync", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/collection/camera-roll/sync")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({
          photos: [
            { r2Key: "a.jpg" },
            { r2Key: "b.jpg", takenAt: "2024-01-01T00:00:00.000Z", location: { lat: 48.8, lng: 2.3 } },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].source).toBe("camera_roll");
      expect(res.body.items[1].location).toEqual({ lat: 48.8, lng: 2.3 });

      expect(getQueueMock("faceDetectionQueue").add).toHaveBeenCalledTimes(2);
      // Per-photo (docs/photo_pipeline_beta_architecture.md section 5).
      expect(getQueueMock("sceneClassificationQueue").add).toHaveBeenCalledTimes(2);
      // Once per sync batch, not once per photo (section 6).
      expect(getQueueMock("photoClusteringQueue").add).toHaveBeenCalledTimes(1);
      expect(getQueueMock("photoClusteringQueue").add).toHaveBeenCalledWith("cluster", { familyGroupId: user.familyGroupId });
    });

    it("requires a non-empty photos array", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/collection/camera-roll/sync")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ photos: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("proposed memories review queue", () => {
    // proposed_memories now requires exactly one of photo_id/cluster_id
    // (migration 024's source-check constraint,
    // docs/photo_pipeline_beta_architecture.md section 9) — a bare proposal
    // with neither set is no longer a valid row, so every helper here seeds
    // a real photo (and, for the cluster case, a real cluster) first.
    async function seedPhoto() {
      const [photo] = await ctx
        .knex()("photos")
        .insert({ family_group_id: user.familyGroupId, r2_key: "p.jpg", uploaded_by: user.personId })
        .returning("*");
      return photo;
    }

    async function createProposal(personId: string = user.personId) {
      const photo = await seedPhoto();
      const [proposal] = await ctx
        .knex()("proposed_memories")
        .insert({ person_id: personId, status: "pending", photo_id: photo.id })
        .returning("*");
      return proposal;
    }

    it("lists only this person's pending proposals", async () => {
      await createProposal();
      const other = await registerTestUser(ctx.request);
      await createProposal(other.personId);

      const res = await ctx
        .request()
        .get("/api/v1/collection/proposed")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });

    it("accept promotes a photo-sourced proposal to a real memory with its photo attached", async () => {
      const proposal = await createProposal();
      const res = await ctx
        .request()
        .post(`/api/v1/collection/proposed/${proposal.id}/accept`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const updated = await ctx.knex()("proposed_memories").where({ id: proposal.id }).first();
      expect(updated.status).toBe("accepted");
      const memories = await ctx.knex()("memories").where({ contributor_id: user.personId });
      expect(memories).toHaveLength(1);
      expect(memories[0].provenance_type).toBe("photo");
      const memoryPhotos = await ctx.knex()("memory_photos").where({ memory_id: memories[0].id });
      expect(memoryPhotos).toHaveLength(1);
      expect(memoryPhotos[0].photo_id).toBe(proposal.photo_id);
    });

    it("accept promotes a cluster-sourced proposal, attaching every photo in the cluster", async () => {
      const [photoA, photoB] = await Promise.all([seedPhoto(), seedPhoto()]);
      const [cluster] = await ctx.knex()("photo_clusters").insert({ family_group_id: user.familyGroupId }).returning("*");
      await ctx.knex()("photo_cluster_photos").insert([
        { cluster_id: cluster.id, photo_id: photoA.id },
        { cluster_id: cluster.id, photo_id: photoB.id },
      ]);
      const [proposal] = await ctx
        .knex()("proposed_memories")
        .insert({ person_id: user.personId, status: "pending", cluster_id: cluster.id })
        .returning("*");

      const res = await ctx
        .request()
        .post(`/api/v1/collection/proposed/${proposal.id}/accept`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const memories = await ctx.knex()("memories").where({ contributor_id: user.personId });
      expect(memories).toHaveLength(1);
      const memoryPhotos = await ctx.knex()("memory_photos").where({ memory_id: memories[0].id });
      expect(memoryPhotos.map((mp: { photo_id: string }) => mp.photo_id).sort()).toEqual([photoA.id, photoB.id].sort());
    });

    it("reject soft-deletes without creating a memory", async () => {
      const proposal = await createProposal();
      const res = await ctx
        .request()
        .post(`/api/v1/collection/proposed/${proposal.id}/reject`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const updated = await ctx.knex()("proposed_memories").where({ id: proposal.id }).first();
      expect(updated.status).toBe("rejected");
      const memories = await ctx.knex()("memories").where({ contributor_id: user.personId });
      expect(memories).toHaveLength(0);
    });

    it("rejects re-resolving an already-resolved proposal", async () => {
      const proposal = await createProposal();
      await ctx.request().post(`/api/v1/collection/proposed/${proposal.id}/accept`).set("Authorization", `Bearer ${user.accessToken}`);
      const res = await ctx
        .request()
        .post(`/api/v1/collection/proposed/${proposal.id}/accept`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });
  });

  describe("privacy tier", () => {
    it("defaults to tier 2 at registration and can be self-updated", async () => {
      const getRes = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/privacy-tier`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(getRes.body.privacyTier).toBe(2);

      const patchRes = await ctx
        .request()
        .patch(`/api/v1/persons/${user.personId}/privacy-tier`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ privacyTier: 1 });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.privacyTier).toBe(1);
    });

    it("rejects changing someone else's privacy tier", async () => {
      const other = await registerTestUser(ctx.request);
      const res = await ctx
        .request()
        .patch(`/api/v1/persons/${other.personId}/privacy-tier`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ privacyTier: 3 });
      expect(res.status).toBe(403);
    });

    it("rejects an invalid tier value", async () => {
      const res = await ctx
        .request()
        .patch(`/api/v1/persons/${user.personId}/privacy-tier`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ privacyTier: 7 });
      expect(res.status).toBe(400);
    });
  });

  describe("question frequency", () => {
    it("defaults to weekly and can be self-updated", async () => {
      const getRes = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/question-frequency`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(getRes.body.questionFrequency).toBe("weekly");

      const patchRes = await ctx
        .request()
        .patch(`/api/v1/persons/${user.personId}/question-frequency`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionFrequency: "daily" });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.questionFrequency).toBe("daily");
    });

    it("rejects an invalid frequency value", async () => {
      const res = await ctx
        .request()
        .patch(`/api/v1/persons/${user.personId}/question-frequency`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionFrequency: "hourly" });
      expect(res.status).toBe(400);
    });
  });

  describe("question prompt", () => {
    it("returns the next unanswered bank question by sort_order", async () => {
      await ctx.knex()("interview_questions").insert([
        { text: "Q1", life_phase: "childhood", sort_order: 2 },
        { text: "Q0", life_phase: "childhood", sort_order: 1 },
      ]);
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/question-prompt`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.question.text).toBe("Q0");
    });

    it("returns null once every question has been answered", async () => {
      const [q] = await ctx.knex()("interview_questions").insert({ text: "Only one", life_phase: "childhood", sort_order: 1 }).returning("*");
      const [session] = await ctx
        .knex()("interview_sessions")
        .insert({ person_id: user.personId, facilitator_person_id: user.personId, status: "completed" })
        .returning("*");
      await ctx.knex()("interview_answers").insert({ session_id: session.id, question_id: q.id, audio_r2_key: "x" });

      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/question-prompt`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.question).toBeNull();
    });
  });
});

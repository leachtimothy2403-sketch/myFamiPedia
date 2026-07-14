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
    it("registers photos and enqueues face detection", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/collection/camera-roll/sync")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ photos: [{ r2Key: "a.jpg" }, { r2Key: "b.jpg", takenAt: "2024-01-01T00:00:00.000Z" }] });
      expect(res.status).toBe(201);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].source).toBe("camera_roll");

      expect(getQueueMock("faceDetectionQueue").add).toHaveBeenCalledTimes(2);
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
    async function createProposal() {
      const [proposal] = await ctx.knex()("proposed_memories").insert({ person_id: user.personId, status: "pending" }).returning("*");
      return proposal;
    }

    it("lists only this person's pending proposals", async () => {
      await createProposal();
      const other = await registerTestUser(ctx.request);
      await ctx.knex()("proposed_memories").insert({ person_id: other.personId, status: "pending" });

      const res = await ctx
        .request()
        .get("/api/v1/collection/proposed")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });

    it("accept promotes the proposal to a real memory", async () => {
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

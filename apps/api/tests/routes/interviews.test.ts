import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

describe("interviews", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  it("lists the question bank, optionally filtered by life phase", async () => {
    await ctx.knex()("interview_questions").insert([
      { text: "Childhood Q", life_phase: "childhood", sort_order: 1 },
      { text: "Work Q", life_phase: "work", sort_order: 2 },
    ]);
    const all = await ctx.request().get("/api/v1/interview-questions").set("Authorization", `Bearer ${user.accessToken}`);
    expect(all.body).toHaveLength(2);

    const filtered = await ctx
      .request()
      .get("/api/v1/interview-questions?lifePhase=work")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].text).toBe("Work Q");
  });

  it("starts a session defaulting the subject to the caller", async () => {
    const res = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.person_id).toBe(user.personId);
    expect(res.body.facilitator_person_id).toBe(user.personId);
    expect(res.body.status).toBe("in_progress");
  });

  it("starts a session for someone else (facilitated)", async () => {
    const [grandma] = await ctx.knex()("persons").insert({ family_group_id: user.familyGroupId, name: "Grandma", status: "active" }).returning("*");
    const res = await ctx
      .request()
      .post("/api/v1/interview-sessions")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ personId: grandma.id });
    expect(res.body.person_id).toBe(grandma.id);
    expect(res.body.facilitator_person_id).toBe(user.personId);
  });

  describe("answers", () => {
    async function startSession() {
      const res = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
      return res.body;
    }
    async function createQuestion() {
      const [q] = await ctx.knex()("interview_questions").insert({ text: "Tell me about...", life_phase: "childhood", sort_order: 1 }).returning("*");
      return q;
    }

    it("attaches an answer with mid-conversation photos staged", async () => {
      const session = await startSession();
      const question = await createQuestion();
      const [photo] = await ctx.knex()("photos").insert({ family_group_id: user.familyGroupId, r2_key: "p.jpg", uploaded_by: user.personId }).returning("*");

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${session.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "answer.mp3", photoIds: [photo.id] });
      expect(res.status).toBe(201);

      const staged = await ctx.knex()("interview_answer_photos").where({ interview_answer_id: res.body.id });
      expect(staged).toHaveLength(1);
      expect(staged[0].photo_id).toBe(photo.id);
    });

    it("requires questionId and audioR2Key", async () => {
      const session = await startSession();
      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${session.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects attaching answers to a completed session", async () => {
      const session = await startSession();
      const question = await createQuestion();
      await ctx.request().post(`/api/v1/interview-sessions/${session.id}/complete`).set("Authorization", `Bearer ${user.accessToken}`);

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${session.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "x.mp3" });
      expect(res.status).toBe(409);
    });
  });

  describe("complete", () => {
    it("marks the session completed and enqueues one transcription job per answer", async () => {
      const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
      const question = await ctx.knex()("interview_questions").insert({ text: "Q", life_phase: "childhood", sort_order: 1 }).returning("*").then((r) => r[0]);

      await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "a1.mp3" });
      await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "a2.mp3" });

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const session = await ctx.knex()("interview_sessions").where({ id: startRes.body.id }).first();
      expect(session.status).toBe("completed");
      expect(session.completed_at).not.toBeNull();

      expect(getQueueMock("transcriptionQueue").add).toHaveBeenCalledTimes(2);
    });

    it("rejects completing an already-completed session", async () => {
      const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
      await ctx.request().post(`/api/v1/interview-sessions/${startRes.body.id}/complete`).set("Authorization", `Bearer ${user.accessToken}`);
      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });
  });

  it("GET returns session status with its answers", async () => {
    const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
    const question = await ctx.knex()("interview_questions").insert({ text: "Q", life_phase: "childhood", sort_order: 1 }).returning("*").then((r) => r[0]);
    await ctx
      .request()
      .post(`/api/v1/interview-sessions/${startRes.body.id}/answers`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ questionId: question.id, audioR2Key: "a1.mp3" });

    const res = await ctx.request().get(`/api/v1/interview-sessions/${startRes.body.id}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.answers).toHaveLength(1);
  });

  it("404s a nonexistent session", async () => {
    const res = await ctx
      .request()
      .get(`/api/v1/interview-sessions/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(404);
  });
});

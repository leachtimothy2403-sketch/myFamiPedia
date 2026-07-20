import { describe, it, expect, beforeEach, vi } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

// POST /question-prompt/:id/answer's text path calls recordAnswerInBiography
// directly (biography.service.ts) — a real Anthropic call several layers
// down (claude.service.ts's callAnthropic) if left unmocked, same gotcha
// interviews.test.ts already documents for its own module-level claude.service.ts
// mock. Mocked at the biography.service.ts layer here instead, since that's
// what collection.routes.ts actually imports directly — narrower than
// mocking claude.service.ts itself, and this file never exercises the
// interview routes that import getBiographySections, so a bare stub for
// every export is enough.
vi.mock("../../src/services/biography.service", () => ({
  recordAnswerInBiography: vi.fn(async () => {}),
  recordMemoryInBiography: vi.fn(async () => {}),
  getBiographySections: vi.fn(async () => []),
}));

describe("collection", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
    // mockQueues() only creates these spies once for the whole file — clear
    // call history each test or an earlier test's calls bleed into the
    // next one's assertion (same fix already applied in uploads.test.ts
    // after hitting this exact issue in an earlier session).
    getQueueMock("photoClusteringQueue").add.mockClear();
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

    // 2026-07-19 — a client registering one sync session across multiple
    // chunked calls needs to suppress the per-call clustering pass, or a
    // single real event straddling a chunk boundary splits into multiple
    // disjoint clusters (docs/media_pipeline.md).
    it("skips the clustering enqueue when skipClustering is true", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/collection/camera-roll/sync")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ photos: [{ r2Key: "a.jpg" }], skipClustering: true });
      expect(res.status).toBe(201);
      expect(getQueueMock("photoClusteringQueue").add).not.toHaveBeenCalled();
    });

    it("still clusters by default when skipClustering is omitted", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/collection/camera-roll/sync")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ photos: [{ r2Key: "a.jpg" }] });
      expect(res.status).toBe(201);
      expect(getQueueMock("photoClusteringQueue").add).toHaveBeenCalledTimes(1);
    });
  });

  describe("camera-roll cluster trigger", () => {
    it("enqueues exactly one deferred clustering pass for the caller's family", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/collection/camera-roll/cluster")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(202);
      expect(getQueueMock("photoClusteringQueue").add).toHaveBeenCalledTimes(1);
      expect(getQueueMock("photoClusteringQueue").add).toHaveBeenCalledWith("cluster", { familyGroupId: user.familyGroupId });
    });

    it("requires auth", async () => {
      const res = await ctx.request().post("/api/v1/collection/camera-roll/cluster");
      expect(res.status).toBe(401);
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

    // Regression test: this endpoint used to 500 outright in any environment
    // without R2 credentials configured (this test suite included —
    // src/config/env.ts never sets R2_ACCOUNT_ID/etc here), because
    // presignDownload throws hard when R2 isn't configured and the route
    // called it unconditionally for every proposal. Fixed via
    // safePresignDownload (best-effort, matching the pattern already used in
    // scheduledJobs.worker.ts's R2 cleanup) — a proposal with no resolvable
    // photo URL should still come back as a normal 200 with photoUrl: null,
    // not take the whole list down.
    it("resolves photo-sourced proposals to photoUrl/caption/photoCount without erroring when R2 isn't configured", async () => {
      await createProposal();
      const res = await ctx
        .request()
        .get("/api/v1/collection/proposed")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        source: "photo",
        photoUrl: null,
        caption: null,
        photoCount: 1,
      });
    });

    it("resolves cluster-sourced proposals to the earliest photo by taken_at, with photoCount matching the cluster size", async () => {
      const [photoA, photoB] = await Promise.all([
        ctx
          .knex()("photos")
          .insert({ family_group_id: user.familyGroupId, r2_key: "later.jpg", uploaded_by: user.personId, taken_at: "2024-01-02" })
          .returning("*")
          .then(([p]: { id: string }[]) => p),
        ctx
          .knex()("photos")
          .insert({ family_group_id: user.familyGroupId, r2_key: "earlier.jpg", uploaded_by: user.personId, taken_at: "2024-01-01" })
          .returning("*")
          .then(([p]: { id: string }[]) => p),
      ]);
      const [cluster] = await ctx.knex()("photo_clusters").insert({ family_group_id: user.familyGroupId }).returning("*");
      await ctx.knex()("photo_cluster_photos").insert([
        { cluster_id: cluster.id, photo_id: photoA.id },
        { cluster_id: cluster.id, photo_id: photoB.id },
      ]);
      await ctx.knex()("proposed_memories").insert({ person_id: user.personId, status: "pending", cluster_id: cluster.id });

      const res = await ctx
        .request()
        .get("/api/v1/collection/proposed")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ source: "cluster", caption: null, photoCount: 2 });
    });

    // 2026-07-19 fix — a real live sync produced a cluster whose
    // chronologically-earliest photo was a photographed schedule (no
    // people), even though a later photo in the same cluster had faces
    // (that's why the cluster passed the face-count gate at all,
    // photoClustering.worker.ts). The review card showed only the
    // no-people photo with no indication anything else was in the cluster.
    // photoUrl itself is always null in this test env (no R2 configured),
    // so this asserts on safePresignDownload's error log instead — it logs
    // the exact r2_key it attempted to presign, which is the only
    // observable signal here of which photo the route actually picked.
    it("prefers a photo with a detected face as the cluster's representative photo, even when it isn't the earliest", async () => {
      const [earlierNoFace, laterWithFace] = await Promise.all([
        ctx
          .knex()("photos")
          .insert({
            family_group_id: user.familyGroupId,
            r2_key: "schedule-photo.jpg",
            uploaded_by: user.personId,
            taken_at: "2024-01-01",
            face_count: 0,
          })
          .returning("*")
          .then(([p]: { id: string }[]) => p),
        ctx
          .knex()("photos")
          .insert({
            family_group_id: user.familyGroupId,
            r2_key: "birthday-photo.jpg",
            uploaded_by: user.personId,
            taken_at: "2024-01-02",
            face_count: 3,
          })
          .returning("*")
          .then(([p]: { id: string }[]) => p),
      ]);
      const [cluster] = await ctx.knex()("photo_clusters").insert({ family_group_id: user.familyGroupId }).returning("*");
      await ctx.knex()("photo_cluster_photos").insert([
        { cluster_id: cluster.id, photo_id: earlierNoFace.id },
        { cluster_id: cluster.id, photo_id: laterWithFace.id },
      ]);
      await ctx.knex()("proposed_memories").insert({ person_id: user.personId, status: "pending", cluster_id: cluster.id });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await ctx
        .request()
        .get("/api/v1/collection/proposed")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);

      const attemptedKeys = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(attemptedKeys.some((msg) => msg.includes("birthday-photo.jpg"))).toBe(true);
      expect(attemptedKeys.some((msg) => msg.includes("schedule-photo.jpg"))).toBe(false);
      errorSpy.mockRestore();
    });

    it("accept promotes a photo-sourced proposal to a real memory with its photo attached, and returns memoryId/photoId for the client to navigate into compose", async () => {
      const proposal = await createProposal();
      const res = await ctx
        .request()
        .post(`/api/v1/collection/proposed/${proposal.id}/accept`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.photoId).toBe(proposal.photo_id);
      expect(res.body.memoryId).toBeDefined();

      const memoryById = await ctx.knex()("memories").where({ id: res.body.memoryId }).first();
      expect(memoryById).toBeDefined();

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
      expect(res.status).toBe(200);
      expect([photoA.id, photoB.id]).toContain(res.body.photoId);
      expect(res.body.memoryId).toBeDefined();

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
        .send({ privacyTier: 3 });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.privacyTier).toBe(3);
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

    // Tier 1 is retired (migration 025) — it had no live behavior left once
    // automated face matching was disabled. See docs/section2_pipeline.md
    // section 1.
    it("rejects the retired tier 1", async () => {
      const res = await ctx
        .request()
        .patch(`/api/v1/persons/${user.personId}/privacy-tier`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ privacyTier: 1 });
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

    // 2026-07-20 — POST /question-prompt/:id/answer, previously a stub
    // (docs/section2_pipeline.md section 4). Reuses interview_answers/
    // interview_sessions as the same "already answered" source of truth the
    // GET endpoint above reads, via migration 027 (audio_r2_key made
    // nullable so a text-only answer can still get a row).
    describe("POST /question-prompt/:id/answer", () => {
      async function seedQuestion(overrides: Partial<Record<string, unknown>> = {}) {
        const [q] = await ctx
          .knex()("interview_questions")
          .insert({ text: "What was your first job?", life_phase: "work", sort_order: 1, ...overrides })
          .returning("*");
        return q;
      }

      it("requires audioR2Key or content", async () => {
        const q = await seedQuestion();
        const res = await ctx
          .request()
          .post(`/api/v1/question-prompt/${q.id}/answer`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({});
        expect(res.status).toBe(400);
      });

      it("404s for an unknown question id", async () => {
        const res = await ctx
          .request()
          .post(`/api/v1/question-prompt/00000000-0000-0000-0000-000000000000/answer`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ content: "Something" });
        expect(res.status).toBe(404);
      });

      it("a text answer creates an interview_answers row, a memory, and updates the biography, without touching Q_TRANS", async () => {
        getQueueMock("transcriptionQueue").add.mockClear();
        const { recordAnswerInBiography } = await import("../../src/services/biography.service");
        const q = await seedQuestion({ text: "What was your first job?", life_phase: "work" });

        const res = await ctx
          .request()
          .post(`/api/v1/question-prompt/${q.id}/answer`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ content: "I worked at a diner downtown." });

        expect(res.status).toBe(201);
        expect(res.body.memoryId).toBeDefined();
        expect(res.body.transcript).toBe("I worked at a diner downtown.");

        const knex = ctx.knex();
        const answerRow = await knex("interview_answers").where({ id: res.body.id }).first();
        expect(answerRow.audio_r2_key).toBeNull();
        expect(answerRow.memory_id).toBe(res.body.memoryId);

        const memory = await knex("memories").where({ id: res.body.memoryId }).first();
        expect(memory.content).toBe("I worked at a diner downtown.");
        expect(memory.provenance_type).toBe("text");
        expect(memory.provenance_label).toBe("What was your first job?");
        expect(memory.contributor_id).toBe(user.personId);

        const tags = await knex("memory_persons").where({ memory_id: res.body.memoryId });
        expect(tags.map((t: { person_id: string }) => t.person_id)).toEqual([user.personId]);

        expect(recordAnswerInBiography as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            personId: user.personId,
            lifePhase: "work",
            question: "What was your first job?",
            answer: "I worked at a diner downtown.",
          })
        );

        expect(getQueueMock("embeddingQueue").add).toHaveBeenCalledWith("embed-memory", { memoryId: res.body.memoryId });
        expect(getQueueMock("transcriptionQueue").add).not.toHaveBeenCalled();

        // The whole point: GET /persons/:id/question-prompt shouldn't offer
        // this question again now that it's been answered.
        const nextRes = await ctx
          .request()
          .get(`/api/v1/persons/${user.personId}/question-prompt`)
          .set("Authorization", `Bearer ${user.accessToken}`);
        expect(nextRes.body.question).toBeNull();
      });

      it("a voice answer creates an untranscribed interview_answers row and falls back to Q_TRANS (no transcription creds configured in tests)", async () => {
        getQueueMock("transcriptionQueue").add.mockClear();
        const q = await seedQuestion();

        const res = await ctx
          .request()
          .post(`/api/v1/question-prompt/${q.id}/answer`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ audioR2Key: "voice/x.m4a" });

        expect(res.status).toBe(201);
        expect(res.body.audio_r2_key).toBe("voice/x.m4a");
        expect(res.body.transcript).toBeNull();

        const knex = ctx.knex();
        const session = await knex("interview_sessions").where({ id: res.body.session_id }).first();
        expect(session.status).toBe("completed");

        expect(getQueueMock("transcriptionQueue").add).toHaveBeenCalledWith("transcribe", { interviewAnswerId: res.body.id });
      });
    });
  });
});

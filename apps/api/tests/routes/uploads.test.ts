import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

// No test file existed for this route before — it had zero coverage.
// Written alongside the fix that makes POST /uploads/:id/complete enqueue
// face detection + embedding for a manually-uploaded photo, since previously
// it got a `photos` row and nothing else. Deliberately NOT scene
// classification or clustering: this endpoint is the "pull" entry point
// (docs/photo_pipeline_beta_architecture.md section 7) — the user
// deliberately chose this photo, so there's nothing for classification/
// clustering to decide. That's a later correction to this same test (it
// originally asserted the full pipeline enqueue, matching an earlier version
// of uploads.routes.ts that has since been narrowed).
describe("uploads", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
    // mockQueues() only creates these spies once for the whole file — clear
    // call history each test so one test's enqueue doesn't leak into the
    // next one's assertion (bit me on this exact pattern once already this
    // session, in sceneClassification.worker.test.ts).
    getQueueMock("faceDetectionQueue").add.mockClear();
    getQueueMock("embeddingQueue").add.mockClear();
    getQueueMock("sceneClassificationQueue").add.mockClear();
    getQueueMock("photoClusteringQueue").add.mockClear();
  });

  describe("POST /uploads/presign", () => {
    it("rejects a missing/invalid context", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/uploads/presign")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ contentType: "image/jpeg", context: "not-a-real-context" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /uploads/:id/complete", () => {
    async function createUpload(context: "photo" | "memory" | "voice" = "photo") {
      const [upload] = await ctx
        .knex()("uploads")
        .insert({ family_group_id: user.familyGroupId, uploaded_by: user.personId, r2_key: `${context}/x.jpg`, context })
        .returning("*");
      return upload;
    }

    it("photo context creates a photos row and enqueues only face detection + embedding (pull path — no classification/clustering)", async () => {
      const upload = await createUpload("photo");
      const res = await ctx
        .request()
        .post(`/api/v1/uploads/${upload.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ takenAt: "2024-01-01T00:00:00.000Z" });
      expect(res.status).toBe(201);
      expect(res.body.photoId).toBeDefined();

      const photo = await ctx.knex()("photos").where({ id: res.body.photoId }).first();
      expect(photo.source).toBe("manual_upload");
      expect(photo.uploaded_by).toBe(user.personId);

      expect(getQueueMock("faceDetectionQueue").add).toHaveBeenCalledWith("detect", { photoId: res.body.photoId });
      expect(getQueueMock("embeddingQueue").add).toHaveBeenCalledWith("embed-photo", { photoId: res.body.photoId });
      // The whole point of the pull path: the user already decided this
      // photo is a memory, so there's nothing for scene classification or
      // clustering to triage — neither queue should be touched.
      expect(getQueueMock("sceneClassificationQueue").add).not.toHaveBeenCalled();
      expect(getQueueMock("photoClusteringQueue").add).not.toHaveBeenCalled();
    });

    it("memory context also creates a photos row and enqueues face detection + embedding only", async () => {
      const upload = await createUpload("memory");
      const res = await ctx
        .request()
        .post(`/api/v1/uploads/${upload.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.photoId).toBeDefined();
      expect(getQueueMock("faceDetectionQueue").add).toHaveBeenCalledTimes(1);
      expect(getQueueMock("embeddingQueue").add).toHaveBeenCalledTimes(1);
      expect(getQueueMock("sceneClassificationQueue").add).not.toHaveBeenCalled();
      expect(getQueueMock("photoClusteringQueue").add).not.toHaveBeenCalled();
    });

    it("voice context is a no-op — no photos row, no pipeline jobs", async () => {
      const upload = await createUpload("voice");
      const res = await ctx
        .request()
        .post(`/api/v1/uploads/${upload.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.photoId).toBeUndefined();
      expect(res.body.r2Key).toBe(upload.r2_key);

      expect(getQueueMock("faceDetectionQueue").add).not.toHaveBeenCalled();
      expect(getQueueMock("embeddingQueue").add).not.toHaveBeenCalled();
      expect(getQueueMock("sceneClassificationQueue").add).not.toHaveBeenCalled();
      expect(getQueueMock("photoClusteringQueue").add).not.toHaveBeenCalled();
    });

    it("404s for an unknown upload id", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/uploads/00000000-0000-0000-0000-000000000000/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(404);
    });

    it("rejects completing an already-completed upload", async () => {
      const upload = await createUpload("photo");
      await ctx.request().post(`/api/v1/uploads/${upload.id}/complete`).set("Authorization", `Bearer ${user.accessToken}`).send({});
      const res = await ctx
        .request()
        .post(`/api/v1/uploads/${upload.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(409);
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

// Retract/restore's biography-recompute call (memories.routes.ts ->
// biography.service.ts's recomputeBiographySection -> claude.service.ts's
// rebuildBiographySectionSummary) is a real Anthropic call — stubbed the
// same importOriginal-based way biography.service.test.ts's own tests are,
// for the same reason documented there: a bare vi.mock of config/env would
// blow away databaseUrl and break withApp()'s DB connection, since this file
// needs both a real DB and a deterministic, offline Claude double regardless
// of whether a real ANTHROPIC_API_KEY happens to be set locally.
vi.mock("../../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env")>();
  return { env: { ...actual.env, anthropicApiKey: "test-key" } };
});

describe("memories", () => {
  const ctx = withApp();
  let user: TestUser;
  let other: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
    other = await registerTestUser(ctx.request);
  });

  async function createMemory(overrides: Partial<Record<string, unknown>> = {}) {
    const [memory] = await ctx
      .knex()("memories")
      .insert({
        family_group_id: user.familyGroupId,
        contributor_id: user.personId,
        content: "A story",
        provenance_type: "text",
        ...overrides,
      })
      .returning("*");
    return memory;
  }

  // No coverage existed for POST /memories itself before — every other test
  // in this file seeds a memories row directly via knex. Added alongside the
  // eventDate fix: nothing validated eventDate's format before it hit a raw
  // Postgres insert, so a value like "July 2026" (typed into
  // collection/compose.tsx's free-text "When" field on mobile) surfaced as
  // an uncaught driver error, and errorHandler.ts's fallback branch forwards
  // err.message verbatim for anything that isn't a thrown HttpError — so the
  // raw `invalid input syntax for type date` error reached the client
  // directly. Also note: no route in this API validates against the zod
  // schemas in packages/shared (createMemorySchema included) — this endpoint
  // still does ad-hoc manual checks matching its existing style, not a zod
  // parse; that's a wider, pre-existing gap, not something fixed here.
  // 2026-07-21 — the compose screen's "suggest people" affordance, answering
  // Tim's "can tagging be auto-detected?" question for the text half only
  // (see claude.service.ts's suggestMentionedPersons comment for why the
  // photo/face half is deliberately not built).
  describe("POST /memories/suggest-tags", () => {
    afterEach(() => vi.unstubAllGlobals());

    function mockClaudeIds(text: string) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) }))
      );
    }

    it("returns suggested person ids mentioned by name in the content", async () => {
      const [grandma] = await ctx.knex()("persons").insert({ family_group_id: user.familyGroupId, name: "Grandma", status: "active" }).returning("*");
      mockClaudeIds(grandma.id);

      const res = await ctx
        .request()
        .post("/api/v1/memories/suggest-tags")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "Grandma used to sing in the choir every Sunday." });
      expect(res.status).toBe(200);
      expect(res.body.personIds).toEqual([grandma.id]);
    });

    it("returns an empty list when Claude says NONE", async () => {
      await ctx.knex()("persons").insert({ family_group_id: user.familyGroupId, name: "Grandma", status: "active" });
      mockClaudeIds("NONE");

      const res = await ctx
        .request()
        .post("/api/v1/memories/suggest-tags")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "A nice quiet day." });
      expect(res.status).toBe(200);
      expect(res.body.personIds).toEqual([]);
    });

    it("drops a hallucinated id that isn't actually in the roster", async () => {
      await ctx.knex()("persons").insert({ family_group_id: user.familyGroupId, name: "Grandma", status: "active" });
      mockClaudeIds("00000000-0000-0000-0000-000000000000");

      const res = await ctx
        .request()
        .post("/api/v1/memories/suggest-tags")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "Something about someone." });
      expect(res.status).toBe(200);
      expect(res.body.personIds).toEqual([]);
    });

    it("requires content", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/memories/suggest-tags")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /memories", () => {
    it("creates a text memory with tagged persons and attached photos", async () => {
      const [photo] = await ctx
        .knex()("photos")
        .insert({ family_group_id: user.familyGroupId, r2_key: "p.jpg", uploaded_by: user.personId })
        .returning("*");

      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({
          content: "A day at the beach",
          eventDate: "2026-07-16",
          provenanceType: "photo",
          personIds: [user.personId],
          photoIds: [photo.id],
        });
      expect(res.status).toBe(201);
      expect(res.body.eventDate ?? res.body.event_date).toBeTruthy();

      const memoryPersons = await ctx.knex()("memory_persons").where({ memory_id: res.body.id });
      expect(memoryPersons).toHaveLength(1);
      const memoryPhotos = await ctx.knex()("memory_photos").where({ memory_id: res.body.id });
      expect(memoryPhotos).toHaveLength(1);
    });

    it("requires content or mediaUrl", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ provenanceType: "text" });
      expect(res.status).toBe(400);
    });

    it("rejects an invalid provenanceType", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "hi", provenanceType: "not-a-real-type" });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed eventDate (e.g. free text typed into the mobile 'When' field) with a clean 400, not a raw DB error", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "Tour de France", provenanceType: "text", eventDate: "July 2026" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/eventDate/i);
      // The bug this guards against: previously this would 500 with the raw
      // Postgres driver message leaking through errorHandler.ts's fallback
      // branch instead of a clean validation error.
      expect(res.body.error).not.toMatch(/invalid input syntax/i);
    });

    it("accepts a null eventDate (optional field)", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "No date given", provenanceType: "text", eventDate: null });
      expect(res.status).toBe(201);
    });

    // 2026-07-20 — memoryBiography.worker.ts: a memory with real content
    // gets folded into the running biography the same way a Q&A answer
    // does, via a queued job (classification + the actual summary rewrite
    // are both Claude calls, kept off the request's critical path).
    it("enqueues a biography update when content is present", async () => {
      getQueueMock("memoryBiographyQueue").add.mockClear();
      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "Grew up two streets from the rail yard", provenanceType: "text" });
      expect(res.status).toBe(201);
      expect(getQueueMock("memoryBiographyQueue").add).toHaveBeenCalledWith("update-biography", { memoryId: res.body.id });
    });

    // A photo-sourced memory created with no content yet (collection.routes.ts's
    // accept flow) has nothing to classify — PATCH /memories/:id below is
    // where this job gets enqueued instead, once/if a caption is added.
    it("does not enqueue a biography update when there's no content to classify", async () => {
      getQueueMock("memoryBiographyQueue").add.mockClear();
      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ mediaUrl: "https://example.com/photo.jpg", provenanceType: "photo" });
      expect(res.status).toBe(201);
      expect(getQueueMock("memoryBiographyQueue").add).not.toHaveBeenCalled();
    });
  });

  // Closes the gap docs/media_pipeline.md flagged: accepting a proposed
  // memory (POST /collection/proposed/:id/accept) creates a bare memory with
  // no content and, before this endpoint existed, no way to add any.
  describe("PATCH /memories/:id", () => {
    it("updates content and re-enqueues embedding", async () => {
      getQueueMock("embeddingQueue").add.mockClear();
      const memory = await createMemory({ content: "original" });
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "updated content" });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe("updated content");
      expect(getQueueMock("embeddingQueue").add).toHaveBeenCalledWith("embed-memory", { memoryId: memory.id });
    });

    it("updates eventDate without re-enqueuing embedding (content unchanged)", async () => {
      getQueueMock("embeddingQueue").add.mockClear();
      const memory = await createMemory();
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ eventDate: "2026-07-16" });
      expect(res.status).toBe(200);
      expect(res.body.event_date).toContain("2026-07-16");
      expect(getQueueMock("embeddingQueue").add).not.toHaveBeenCalled();
    });

    // 2026-07-20 — this is the actual trigger point for a photo-sourced
    // memory (created via collection.routes.ts's accept flow with
    // content: null) to ever reach the biography at all: it has nothing to
    // classify until a caption gets added here.
    it("enqueues a biography update when a caption/content is added to a previously-empty memory", async () => {
      getQueueMock("memoryBiographyQueue").add.mockClear();
      const memory = await createMemory({ content: null, provenance_type: "photo" });
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "The whole family at the lake house, summer of '82" });
      expect(res.status).toBe(200);
      expect(getQueueMock("memoryBiographyQueue").add).toHaveBeenCalledWith("update-biography", { memoryId: memory.id });
    });

    it("does not enqueue a biography update for an eventDate-only edit", async () => {
      getQueueMock("memoryBiographyQueue").add.mockClear();
      const memory = await createMemory();
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ eventDate: "2026-07-16" });
      expect(res.status).toBe(200);
      expect(getQueueMock("memoryBiographyQueue").add).not.toHaveBeenCalled();
    });

    it("rejects a malformed eventDate with a clean 400", async () => {
      const memory = await createMemory();
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ eventDate: "not-a-date" });
      expect(res.status).toBe(400);
    });

    it("requires content or eventDate", async () => {
      const memory = await createMemory();
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects an edit from anyone other than the contributor", async () => {
      const memory = await createMemory();
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${other.accessToken}`)
        .send({ content: "hijacked" });
      expect(res.status).toBe(403);
    });

    it("404s on a nonexistent memory", async () => {
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "x" });
      expect(res.status).toBe(404);
    });

    it("rejects editing a posthumous contribution — moderation-only, same rule as delete/retract", async () => {
      const memory = await createMemory({ is_posthumous_contribution: true });
      const res = await ctx
        .request()
        .patch(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "edited" });
      expect(res.status).toBe(403);
    });
  });

  // 2026-07-19 — the picker behind "select which photos to keep in a memory
  // from a cluster" (docs/media_pipeline.md). Accepting a cluster-sourced
  // proposal attaches every one of its photos to the new memory
  // unconditionally; these two endpoints are what let compose.tsx list them
  // and trim the ones that don't belong.
  describe("GET /memories/:id/photos", () => {
    async function attachPhotos(memoryId: string, count: number) {
      const photos = await ctx
        .knex()("photos")
        .insert(
          Array.from({ length: count }, (_, i) => ({
            family_group_id: user.familyGroupId,
            r2_key: `p${i}.jpg`,
            uploaded_by: user.personId,
            taken_at: new Date(2026, 6, 10 + i),
          }))
        )
        .returning("*");
      await ctx
        .knex()("memory_photos")
        .insert(photos.map((p: { id: string }) => ({ memory_id: memoryId, photo_id: p.id })));
      return photos;
    }

    it("lists a memory's attached photos ordered by taken_at", async () => {
      const memory = await createMemory();
      const photos = await attachPhotos(memory.id, 3);

      const res = await ctx
        .request()
        .get(`/api/v1/memories/${memory.id}/photos`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(photos.map((p: { id: string }) => p.id));
      // photoUrl is null in the test env (no R2 configured) — safePresignDownload's fallback.
      expect(res.body.items[0]).toHaveProperty("photoUrl", null);
      expect(res.body.items[0]).toHaveProperty("faceCount");
    });

    it("404s on a nonexistent memory", async () => {
      const res = await ctx
        .request()
        .get(`/api/v1/memories/00000000-0000-0000-0000-000000000000/photos`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /memories/:id/photos/:photoId", () => {
    async function attachPhotos(memoryId: string, count: number) {
      const photos = await ctx
        .knex()("photos")
        .insert(
          Array.from({ length: count }, (_, i) => ({
            family_group_id: user.familyGroupId,
            r2_key: `p${i}.jpg`,
            uploaded_by: user.personId,
          }))
        )
        .returning("*");
      await ctx
        .knex()("memory_photos")
        .insert(photos.map((p: { id: string }) => ({ memory_id: memoryId, photo_id: p.id })));
      return photos;
    }

    it("removes one photo from a memory that has several", async () => {
      const memory = await createMemory();
      const photos = await attachPhotos(memory.id, 3);

      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}/photos/${photos[0].id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const remaining = await ctx.knex()("memory_photos").where({ memory_id: memory.id });
      expect(remaining).toHaveLength(2);
      expect(remaining.map((r: { photo_id: string }) => r.photo_id)).not.toContain(photos[0].id);
    });

    it("refuses to remove the last photo (400)", async () => {
      const memory = await createMemory();
      const photos = await attachPhotos(memory.id, 1);

      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}/photos/${photos[0].id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(400);

      const remaining = await ctx.knex()("memory_photos").where({ memory_id: memory.id });
      expect(remaining).toHaveLength(1);
    });

    it("404s when the photo isn't attached to this memory", async () => {
      const memory = await createMemory();
      await attachPhotos(memory.id, 2);
      const [strayPhoto] = await ctx
        .knex()("photos")
        .insert({ family_group_id: user.familyGroupId, r2_key: "stray.jpg", uploaded_by: user.personId })
        .returning("*");

      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}/photos/${strayPhoto.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(404);
    });

    it("rejects removal from anyone other than the contributor (403)", async () => {
      const memory = await createMemory();
      const photos = await attachPhotos(memory.id, 2);

      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}/photos/${photos[0].id}`)
        .set("Authorization", `Bearer ${other.accessToken}`);
      expect(res.status).toBe(403);
    });

    it("rejects removal on a posthumous contribution (403)", async () => {
      const memory = await createMemory({ is_posthumous_contribution: true });
      const photos = await attachPhotos(memory.id, 2);

      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}/photos/${photos[0].id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(403);
    });

    it("404s on a nonexistent memory", async () => {
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/00000000-0000-0000-0000-000000000000/photos/00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  it("reacts to a memory idempotently (onConflict ignore)", async () => {
    const memory = await createMemory();
    const res1 = await ctx
      .request()
      .post(`/api/v1/memories/${memory.id}/react`)
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ reactionType: "touched_me" });
    expect(res1.status).toBe(204);

    const res2 = await ctx
      .request()
      .post(`/api/v1/memories/${memory.id}/react`)
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ reactionType: "touched_me" });
    expect(res2.status).toBe(204);

    const rows = await ctx.knex()("reactions").where({ memory_id: memory.id });
    expect(rows).toHaveLength(1);
  });

  it("requires a reactionType", async () => {
    const memory = await createMemory();
    const res = await ctx
      .request()
      .post(`/api/v1/memories/${memory.id}/react`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  describe("DELETE (three-tier policy)", () => {
    it("hard-deletes an unlinked, unreacted, non-voice, non-posthumous memory", async () => {
      const memory = await createMemory();
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);
      const row = await ctx.knex()("memories").where({ id: memory.id }).first();
      expect(row).toBeUndefined();
    });

    it("rejects delete from anyone other than the contributor (403)", async () => {
      const memory = await createMemory();
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${other.accessToken}`);
      expect(res.status).toBe(403);
      const row = await ctx.knex()("memories").where({ id: memory.id }).first();
      expect(row).toBeDefined();
    });

    it("refuses to hard-delete a voice-provenance memory (403) — trigger is the backstop", async () => {
      const memory = await createMemory({ provenance_type: "voice" });
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/cannot be hard-deleted/);
    });

    it("refuses to hard-delete a posthumous contribution (403)", async () => {
      const memory = await createMemory({ is_posthumous_contribution: true });
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(403);
    });

    it("refuses to hard-delete a reacted-to memory (409) — use retract instead", async () => {
      const memory = await createMemory();
      await ctx.knex()("reactions").insert({ memory_id: memory.id, person_id: other.personId, reaction_type: "touched_me" });
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });

    it("refuses to hard-delete a memory linked to another person (409)", async () => {
      const memory = await createMemory();
      await ctx.knex()("memory_persons").insert({ memory_id: memory.id, person_id: other.personId });
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/${memory.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });

    it("404s on a nonexistent memory", async () => {
      const res = await ctx
        .request()
        .delete(`/api/v1/memories/00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("retract / restore", () => {
    it("retracts a memory and notifies reactors", async () => {
      const memory = await createMemory();
      await ctx.knex()("reactions").insert({ memory_id: memory.id, person_id: other.personId, reaction_type: "touched_me" });

      const res = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/retract`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const row = await ctx.knex()("memories").where({ id: memory.id }).first();
      expect(row.retracted).toBe(true);
      expect(row.retracted_at).not.toBeNull();

      expect(getQueueMock("notificationQueue").add).toHaveBeenCalledWith(
        "memory-retracted",
        expect.objectContaining({ recipientPersonId: other.personId })
      );
    });

    it("rejects retract from a non-contributor (403)", async () => {
      const memory = await createMemory();
      const res = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/retract`)
        .set("Authorization", `Bearer ${other.accessToken}`);
      expect(res.status).toBe(403);
    });

    it("rejects retracting an already-retracted memory (409)", async () => {
      const memory = await createMemory({ retracted: true, retracted_at: new Date() });
      const res = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/retract`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });

    it("rejects retracting a posthumous contribution (403)", async () => {
      const memory = await createMemory({ is_posthumous_contribution: true });
      const res = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/retract`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(403);
    });

    it("restore-request notifies the contributor but does not itself restore", async () => {
      const memory = await createMemory({ retracted: true, retracted_at: new Date() });
      const res = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/restore-request`)
        .set("Authorization", `Bearer ${other.accessToken}`);
      expect(res.status).toBe(204);

      expect(getQueueMock("notificationQueue").add).toHaveBeenCalledWith(
        "memory-restore-requested",
        expect.objectContaining({ recipientPersonId: user.personId })
      );
      const row = await ctx.knex()("memories").where({ id: memory.id }).first();
      expect(row.retracted).toBe(true); // unchanged
    });

    it("only the contributor can actually restore", async () => {
      const memory = await createMemory({ retracted: true, retracted_at: new Date() });

      const forbidden = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/restore`)
        .set("Authorization", `Bearer ${other.accessToken}`);
      expect(forbidden.status).toBe(403);

      const ok = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/restore`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(ok.status).toBe(204);

      const row = await ctx.knex()("memories").where({ id: memory.id }).first();
      expect(row.retracted).toBe(false);
      expect(row.retracted_at).toBeNull();
    });

    it("rejects restoring a memory that isn't retracted (409)", async () => {
      const memory = await createMemory();
      const res = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/restore`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });

    // 2026-07-20 — the actual bug Tim reported live: retracting a Q&A answer
    // (or any memory) left its content sitting in the running biography
    // forever, since recordAnswerInBiography only ever folds content IN.
    // These exercise the fix end to end: retract/restore now rebuild the
    // affected section(s) from whatever interview_biography_sources rows
    // still have a live memory behind them (biography.service.ts's
    // recomputeBiographySection, migration 028).
    describe("retract/restore recomputes the affected biography section", () => {
      afterEach(() => vi.unstubAllGlobals());

      function mockRebuiltSummary(text: string) {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) }))
        );
      }

      async function seedSection(memoryIds: { id: string; stem: string; content: string }[]) {
        await ctx.knex()("interview_biography_sections").insert({
          person_id: user.personId,
          life_phase: "childhood",
          summary: "Grew up near the rail yard and had a cat named Rusty.",
          asked_question_stems: memoryIds.map((m) => m.stem),
          question_count: memoryIds.length,
        });
        await ctx.knex()("interview_biography_sources").insert(
          memoryIds.map((m) => ({
            person_id: user.personId,
            life_phase: "childhood",
            memory_id: m.id,
            stem: m.stem,
            content: m.content,
          }))
        );
      }

      it("rebuilds the section without the retracted memory's content", async () => {
        const memoryA = await createMemory({ content: "We lived two streets from the rail yard." });
        const memoryB = await createMemory({ content: "I found a stray cat and named him Rusty." });
        await seedSection([
          { id: memoryA.id, stem: "street", content: memoryA.content },
          { id: memoryB.id, stem: "(memory shared: \"cat\")", content: memoryB.content },
        ]);
        mockRebuiltSummary("Grew up near the rail yard.");

        const res = await ctx
          .request()
          .post(`/api/v1/memories/${memoryB.id}/retract`)
          .set("Authorization", `Bearer ${user.accessToken}`);
        expect(res.status).toBe(204);

        const section = await ctx
          .knex()("interview_biography_sections")
          .where({ person_id: user.personId, life_phase: "childhood" })
          .first();
        expect(section.summary).toBe("Grew up near the rail yard.");
        expect(section.asked_question_stems).toEqual(["street"]);
        expect(section.question_count).toBe(1);
      });

      it("brings the content back into the rebuilt section on restore", async () => {
        const memoryA = await createMemory({ content: "We lived two streets from the rail yard." });
        const memoryB = await createMemory({ content: "I found a stray cat and named him Rusty." });
        await seedSection([
          { id: memoryA.id, stem: "street", content: memoryA.content },
          { id: memoryB.id, stem: "(memory shared: \"cat\")", content: memoryB.content },
        ]);

        mockRebuiltSummary("Grew up near the rail yard.");
        await ctx
          .request()
          .post(`/api/v1/memories/${memoryB.id}/retract`)
          .set("Authorization", `Bearer ${user.accessToken}`);

        mockRebuiltSummary("Grew up near the rail yard and rescued a stray cat named Rusty.");
        const res = await ctx
          .request()
          .post(`/api/v1/memories/${memoryB.id}/restore`)
          .set("Authorization", `Bearer ${user.accessToken}`);
        expect(res.status).toBe(204);

        const section = await ctx
          .knex()("interview_biography_sections")
          .where({ person_id: user.personId, life_phase: "childhood" })
          .first();
        expect(section.summary).toBe("Grew up near the rail yard and rescued a stray cat named Rusty.");
        expect(section.asked_question_stems.sort()).toEqual(["(memory shared: \"cat\")", "street"].sort());
        expect(section.question_count).toBe(2);
      });

      it("deletes the section entirely when retracting its only surviving source", async () => {
        const memory = await createMemory({ content: "I found a stray cat and named him Rusty." });
        await seedSection([{ id: memory.id, stem: "(memory shared: \"cat\")", content: memory.content }]);

        const res = await ctx
          .request()
          .post(`/api/v1/memories/${memory.id}/retract`)
          .set("Authorization", `Bearer ${user.accessToken}`);
        expect(res.status).toBe(204);

        const section = await ctx
          .knex()("interview_biography_sections")
          .where({ person_id: user.personId, life_phase: "childhood" })
          .first();
        expect(section).toBeUndefined();
      });
    });
  });

  // docs/family_administrator_and_privacy_model.md section 3 — the Juliette
  // bug: a memory tagging both an active and a still-pending person used to
  // show live on the pending person's profile immediately. Fixed per-tag,
  // not per-memory.
  describe("POST /memories — tagging a still-pending person", () => {
    it("tags the active person directly but holds the pending person's tag instead of writing memory_persons", async () => {
      const [activePerson] = await ctx
        .knex()("persons")
        .insert({ family_group_id: user.familyGroupId, name: "Active Cousin", status: "active" })
        .returning("*");
      const [pendingPerson] = await ctx
        .knex()("persons")
        .insert({ family_group_id: user.familyGroupId, name: "Pending Cousin", status: "invited_pending" })
        .returning("*");

      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "A story about both of you", personIds: [activePerson.id, pendingPerson.id] });
      expect(res.status).toBe(201);

      const memoryPersons = await ctx.knex()("memory_persons").where({ memory_id: res.body.id });
      expect(memoryPersons.map((mp: { person_id: string }) => mp.person_id)).toEqual([activePerson.id]);

      const held = await ctx.knex()("holding_space").where({ person_id: pendingPerson.id }).first();
      expect(held).toBeDefined();
      expect(held.media_type).toBe("mention");
      expect(held.raw_metadata.memoryId).toBe(res.body.id);
    });

    it("promotes the held mention into memory_persons once the pending person is drained", async () => {
      const [pendingPerson] = await ctx
        .knex()("persons")
        .insert({ family_group_id: user.familyGroupId, name: "Pending Cousin", status: "invited_pending" })
        .returning("*");
      const res = await ctx
        .request()
        .post("/api/v1/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "About the pending cousin", personIds: [pendingPerson.id] });
      expect(res.status).toBe(201);

      const { processDrainJob } = await import("../../src/jobs/holdingSpaceDrain.worker");
      const result = await processDrainJob({ personId: pendingPerson.id });
      expect(result.mentionsPromoted).toBe(1);

      const memoryPersons = await ctx.knex()("memory_persons").where({ memory_id: res.body.id, person_id: pendingPerson.id });
      expect(memoryPersons).toHaveLength(1);
      const held = await ctx.knex()("holding_space").where({ person_id: pendingPerson.id }).first();
      expect(held.archived_at).not.toBeNull();
    });
  });
});

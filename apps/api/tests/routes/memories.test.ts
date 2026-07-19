import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

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

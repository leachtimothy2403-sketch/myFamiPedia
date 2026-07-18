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

import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("moderation", () => {
  const ctx = withApp();
  let user: TestUser;
  let other: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
    other = await registerTestUser(ctx.request);
  });

  async function createMemory(contributorId: string) {
    const [memory] = await ctx
      .knex()("memories")
      .insert({ family_group_id: user.familyGroupId, contributor_id: contributorId, content: "x", provenance_type: "text" })
      .returning("*");
    return memory;
  }

  it("files a flag against a memory", async () => {
    const memory = await createMemory(user.personId);
    const res = await ctx
      .request()
      .post("/api/v1/flags")
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ contentType: "memory", contentId: memory.id, description: "This seems wrong" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.reporter_person_id).toBe(other.personId);
  });

  it("validates contentType", async () => {
    const res = await ctx
      .request()
      .post("/api/v1/flags")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ contentType: "bogus", contentId: "x", description: "y" });
    expect(res.status).toBe(400);
  });

  it("lists flags for the moderation queue, optionally by status", async () => {
    const memory = await createMemory(user.personId);
    await ctx.knex()("flags").insert([
      { content_type: "memory", content_id: memory.id, reporter_person_id: other.personId, description: "a", status: "open" },
      { content_type: "memory", content_id: memory.id, reporter_person_id: other.personId, description: "b", status: "dismissed" },
    ]);

    const all = await ctx.request().get("/api/v1/flags").set("Authorization", `Bearer ${user.accessToken}`);
    expect(all.body.items).toHaveLength(2);

    const openOnly = await ctx.request().get("/api/v1/flags?status=open").set("Authorization", `Bearer ${user.accessToken}`);
    expect(openOnly.body.items).toHaveLength(1);
  });

  it("resolves a flag (remove/dismiss)", async () => {
    const memory = await createMemory(user.personId);
    const [flag] = await ctx
      .knex()("flags")
      .insert({ content_type: "memory", content_id: memory.id, reporter_person_id: other.personId, description: "a" })
      .returning("*");

    const res = await ctx
      .request()
      .patch(`/api/v1/flags/${flag.id}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ status: "removed", resolution: "Confirmed inappropriate" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("removed");
    expect(res.body.resolution).toBe("Confirmed inappropriate");
  });

  it("validates the resolution status", async () => {
    const memory = await createMemory(user.personId);
    const [flag] = await ctx.knex()("flags").insert({ content_type: "memory", content_id: memory.id, reporter_person_id: other.personId, description: "a" }).returning("*");
    const res = await ctx
      .request()
      .patch(`/api/v1/flags/${flag.id}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ status: "bogus" });
    expect(res.status).toBe(400);
  });

  describe("appeal", () => {
    it("lets the memory's own contributor appeal a removal", async () => {
      const memory = await createMemory(user.personId);
      const [flag] = await ctx
        .knex()("flags")
        .insert({ content_type: "memory", content_id: memory.id, reporter_person_id: other.personId, description: "a", status: "removed" })
        .returning("*");

      const res = await ctx
        .request()
        .post(`/api/v1/flags/${flag.id}/appeal`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ description: "This was taken out of context" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("appealed");
      expect(res.body.description).toBe("This was taken out of context");
    });

    it("rejects an appeal from someone other than the content's contributor", async () => {
      const memory = await createMemory(user.personId);
      const [flag] = await ctx
        .knex()("flags")
        .insert({ content_type: "memory", content_id: memory.id, reporter_person_id: other.personId, description: "a", status: "removed" })
        .returning("*");

      const res = await ctx
        .request()
        .post(`/api/v1/flags/${flag.id}/appeal`)
        .set("Authorization", `Bearer ${other.accessToken}`)
        .send({ description: "Let me back in" });
      expect(res.status).toBe(403);
    });

    it("rejects appealing a flag that isn't removed", async () => {
      const memory = await createMemory(user.personId);
      const [flag] = await ctx
        .knex()("flags")
        .insert({ content_type: "memory", content_id: memory.id, reporter_person_id: other.personId, description: "a", status: "open" })
        .returning("*");
      const res = await ctx
        .request()
        .post(`/api/v1/flags/${flag.id}/appeal`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ description: "x" });
      expect(res.status).toBe(409);
    });
  });
});

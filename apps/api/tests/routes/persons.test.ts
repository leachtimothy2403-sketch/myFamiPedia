import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("persons", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  describe("GET /persons/:id", () => {
    it("returns the person's profile", async () => {
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(user.personId);
    });

    it("404s for a nonexistent person", async () => {
      const res = await ctx
        .request()
        .get(`/api/v1/persons/00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(404);
    });

    it("masks profile_data and ai_summary for an opted-out person", async () => {
      const [optedOut] = await ctx
        .knex()("persons")
        .insert({
          family_group_id: user.familyGroupId,
          name: "Opted Out",
          status: "opted_out",
          profile_data: JSON.stringify({ favorite_color: "blue" }),
          ai_summary: "Some summary",
        })
        .returning("*");
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${optedOut.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.profile_data).toBeNull();
      expect(res.body.ai_summary).toBeNull();
    });
  });

  it("PATCH /persons/:id updates profile fields", async () => {
    const res = await ctx
      .request()
      .patch(`/api/v1/persons/${user.personId}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "New Name", birthDate: "1990-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
    expect(res.body.birth_date).toContain("1990-01-01");
  });

  describe("GET /persons/:id/summary", () => {
    it("reports generated:false when no ai_summary exists yet", async () => {
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/summary`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.generated).toBe(false);
      expect(res.body.summary).toBeNull();
    });

    it("returns the cached summary, labeled as AI-generated, when present", async () => {
      await ctx.knex()("persons").where({ id: user.personId }).update({ ai_summary: "A life well lived." });
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/summary`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.generated).toBe(true);
      expect(res.body.aiGenerated).toBe(true);
      expect(res.body.summary).toBe("A life well lived.");
    });
  });

  describe("timeline and memories feed", () => {
    it("returns only dated memories in the timeline, ordered by date", async () => {
      await ctx.knex()("memories").insert([
        { family_group_id: user.familyGroupId, contributor_id: user.personId, content: "Undated", provenance_type: "text" },
        {
          family_group_id: user.familyGroupId,
          contributor_id: user.personId,
          content: "Later",
          provenance_type: "text",
          event_date: "2020-01-01",
        },
        {
          family_group_id: user.familyGroupId,
          contributor_id: user.personId,
          content: "Earlier",
          provenance_type: "text",
          event_date: "2010-01-01",
        },
      ]);
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/timeline`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].content).toBe("Earlier");
      expect(res.body.items[1].content).toBe("Later");
    });

    it("includes memories where the person is featured, not just contributed", async () => {
      const [other] = await ctx
        .knex()("persons")
        .insert({ family_group_id: user.familyGroupId, name: "Other", status: "active" })
        .returning("*");
      const [memory] = await ctx
        .knex()("memories")
        .insert({ family_group_id: user.familyGroupId, contributor_id: other.id, content: "About user", provenance_type: "text" })
        .returning("*");
      await ctx.knex()("memory_persons").insert({ memory_id: memory.id, person_id: user.personId });

      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/memories`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].content).toBe("About user");
    });

    it("paginates the memories feed", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        family_group_id: user.familyGroupId,
        contributor_id: user.personId,
        content: `Memory ${i}`,
        provenance_type: "text",
      }));
      await ctx.knex()("memories").insert(rows);
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/memories?page=1&pageSize=2`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(2);
    });
  });

  describe("relationships", () => {
    it("creates and lists relationships", async () => {
      const [spouse] = await ctx
        .knex()("persons")
        .insert({ family_group_id: user.familyGroupId, name: "Spouse", status: "active" })
        .returning("*");

      const createRes = await ctx
        .request()
        .post(`/api/v1/relationships`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ personAId: user.personId, personBId: spouse.id, relationshipType: "spouse_of" });
      expect(createRes.status).toBe(201);

      const listRes = await ctx
        .request()
        .get(`/api/v1/relationships`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.items).toHaveLength(1);

      const filteredRes = await ctx
        .request()
        .get(`/api/v1/relationships?personId=${spouse.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(filteredRes.body.items).toHaveLength(1);
    });

    it("requires all three relationship fields", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/relationships`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ personAId: user.personId });
      expect(res.status).toBe(400);
    });
  });
});

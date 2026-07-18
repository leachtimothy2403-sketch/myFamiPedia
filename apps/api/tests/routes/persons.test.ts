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

    it("includes voice (Q&A-recorded) memories by default, for the manage-memories screen", async () => {
      await ctx.knex()("memories").insert({
        family_group_id: user.familyGroupId,
        contributor_id: user.personId,
        content: "Recorded answer",
        provenance_type: "voice",
      });
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/memories`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].provenance_type).toBe("voice");
    });

    it("excludeVoice=true drops Q&A-recorded memories, for the profile Memories Feed", async () => {
      await ctx.knex()("memories").insert([
        { family_group_id: user.familyGroupId, contributor_id: user.personId, content: "Recorded answer", provenance_type: "voice" },
        { family_group_id: user.familyGroupId, contributor_id: user.personId, content: "Typed in by hand", provenance_type: "text" },
      ]);
      const res = await ctx
        .request()
        .get(`/api/v1/persons/${user.personId}/memories?excludeVoice=true`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].content).toBe("Typed in by hand");
    });
  });

  describe("GET /family-groups/:id/memories (Home tab family feed)", () => {
    it("returns memories contributed by anyone in the family group", async () => {
      const [other] = await ctx
        .knex()("persons")
        .insert({ family_group_id: user.familyGroupId, name: "Other", status: "active" })
        .returning("*");
      await ctx.knex()("memories").insert({
        family_group_id: user.familyGroupId,
        contributor_id: other.id,
        content: "Other's memory",
        provenance_type: "text",
      });
      const res = await ctx
        .request()
        .get(`/api/v1/family-groups/${user.familyGroupId}/memories`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].content).toBe("Other's memory");
      expect(res.body.items[0].contributor_name).toBe("Other");
    });

    it("does not return memories from a different family group", async () => {
      const otherFamily = await registerTestUser(ctx.request);
      await ctx.knex()("memories").insert({
        family_group_id: otherFamily.familyGroupId,
        contributor_id: otherFamily.personId,
        content: "Not this family",
        provenance_type: "text",
      });
      const res = await ctx
        .request()
        .get(`/api/v1/family-groups/${user.familyGroupId}/memories`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
    });

    it("excludeVoice=true drops Q&A-recorded memories from the family feed", async () => {
      await ctx.knex()("memories").insert([
        { family_group_id: user.familyGroupId, contributor_id: user.personId, content: "Recorded answer", provenance_type: "voice" },
        { family_group_id: user.familyGroupId, contributor_id: user.personId, content: "Typed in by hand", provenance_type: "text" },
      ]);
      const res = await ctx
        .request()
        .get(`/api/v1/family-groups/${user.familyGroupId}/memories?excludeVoice=true`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].content).toBe("Typed in by hand");
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

  describe("posthumous contribution (Section 4)", () => {
    it("creates a deceased profile in 'collecting' state, with no invitation row", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/persons/deceased`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ name: "Grandpa Joe", deathDate: "2015-06-01", relationshipType: "parent_of", relatedToPersonId: user.personId });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("deceased");
      expect(res.body.deceased_profile_state).toBe("collecting");
      expect(res.body.administrator_person_id).toBe(user.personId);

      const invitations = await ctx.knex()("invitations").where({ person_id: res.body.id });
      expect(invitations).toHaveLength(0);
      const relationships = await ctx.knex()("relationships").where({ person_b_id: res.body.id });
      expect(relationships).toHaveLength(1);
    });

    it("requires name, deathDate, relationshipType, and relatedToPersonId", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/persons/deceased`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ name: "Grandpa Joe" });
      expect(res.status).toBe(400);
    });

    describe("PATCH /persons/:id/state", () => {
      async function createDeceased() {
        const res = await ctx
          .request()
          .post(`/api/v1/persons/deceased`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ name: "Grandma Rose", deathDate: "2018-03-01", relationshipType: "parent_of", relatedToPersonId: user.personId });
        return res.body;
      }

      it("moves collecting -> complete for the profile's administrator", async () => {
        const deceased = await createDeceased();
        const res = await ctx
          .request()
          .patch(`/api/v1/persons/${deceased.id}/state`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ state: "complete" });
        expect(res.status).toBe(200);
        expect(res.body.deceased_profile_state).toBe("complete");
      });

      it("rejects a non-administrator", async () => {
        const deceased = await createDeceased();
        const other = await registerTestUser(ctx.request);
        const res = await ctx
          .request()
          .patch(`/api/v1/persons/${deceased.id}/state`)
          .set("Authorization", `Bearer ${other.accessToken}`)
          .send({ state: "complete" });
        expect(res.status).toBe(403);
      });

      it("rejects state changes on a non-deceased profile", async () => {
        const res = await ctx
          .request()
          .patch(`/api/v1/persons/${user.personId}/state`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ state: "complete" });
        expect(res.status).toBe(409);
      });

      it("validates the state value", async () => {
        const deceased = await createDeceased();
        const res = await ctx
          .request()
          .patch(`/api/v1/persons/${deceased.id}/state`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ state: "bogus" });
        expect(res.status).toBe(400);
      });
    });

    describe("POST /persons/:id/memories", () => {
      it("lets any family member contribute a memory, marked posthumous, and enqueues embedding", async () => {
        const deceased = await ctx
          .request()
          .post(`/api/v1/persons/deceased`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ name: "Uncle Theo", deathDate: "2019-09-01", relationshipType: "sibling_of", relatedToPersonId: user.personId })
          .then((r) => r.body);

        const res = await ctx
          .request()
          .post(`/api/v1/persons/${deceased.id}/memories`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ content: "He always made us laugh." });
        expect(res.status).toBe(201);
        expect(res.body.is_posthumous_contribution).toBe(true);
        expect(res.body.contributor_id).toBe(user.personId);
        expect(res.body.provenance_type).toBe("text");

        const links = await ctx.knex()("memory_persons").where({ memory_id: res.body.id, person_id: deceased.id });
        expect(links).toHaveLength(1);

        const { getQueueMock } = await import("../helpers/queueMock");
        expect(getQueueMock("embeddingQueue").add).toHaveBeenCalledWith("embed-memory", { memoryId: res.body.id });
      });

      it("rejects contributing to a living person's profile", async () => {
        const res = await ctx
          .request()
          .post(`/api/v1/persons/${user.personId}/memories`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ content: "This should fail" });
        expect(res.status).toBe(409);
      });

      it("requires content or mediaUrl", async () => {
        const deceased = await ctx
          .request()
          .post(`/api/v1/persons/deceased`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({ name: "Aunt May", deathDate: "2020-01-01", relationshipType: "sibling_of", relatedToPersonId: user.personId })
          .then((r) => r.body);
        const res = await ctx
          .request()
          .post(`/api/v1/persons/${deceased.id}/memories`)
          .set("Authorization", `Bearer ${user.accessToken}`)
          .send({});
        expect(res.status).toBe(400);
      });
    });
  });
});

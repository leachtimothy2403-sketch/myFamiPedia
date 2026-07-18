import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

// docs/family_administrator_and_privacy_model.md section 1. `admin` always
// registers first with no familyGroupId (creates a brand-new family group,
// becomes its administrator by default); `member` always joins THAT SAME
// family via familyGroupId, so these two are genuinely in one family group
// with exactly one administrator between them — unlike most other test
// files in this suite, where "user" and "other" are actually two separate,
// unrelated families (harmless there since RLS is bypassed by the pglite
// superuser test connection; deliberately avoided here since this file's
// whole point is testing who's the administrator OF WHOM).
describe("family administrator", () => {
  const ctx = withApp();
  let admin: TestUser;
  let member: TestUser;

  beforeEach(async () => {
    admin = await registerTestUser(ctx.request);
    member = await registerTestUser(ctx.request, { familyGroupId: admin.familyGroupId });
  });

  it("makes whoever creates a new family group its administrator by default", async () => {
    const row = await ctx.knex()("persons").where({ id: admin.personId }).first();
    expect(row.family_role).toBe("administrator");
  });

  it("does not make someone joining an existing family group an administrator", async () => {
    const row = await ctx.knex()("persons").where({ id: member.personId }).first();
    expect(row.family_role).toBeNull();
  });

  it("enforces exactly one administrator per family group at the DB level", async () => {
    await expect(
      ctx.knex()("persons").where({ id: member.personId }).update({ family_role: "administrator" })
    ).rejects.toThrow();
  });

  describe("gated actions", () => {
    it("blocks a non-administrator from manually adding a family member", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/invitations")
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ name: "Cousin Jo", relationshipType: "other", relatedToPersonId: member.personId });
      expect(res.status).toBe(403);
    });

    it("allows the administrator to manually add a family member", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/invitations")
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ name: "Cousin Jo", relationshipType: "other", relatedToPersonId: admin.personId });
      expect(res.status).toBe(201);
    });

    it("leaves the photo-tag-triggered invitation path open to any family member", async () => {
      const [photo] = await ctx
        .knex()("photos")
        .insert({ family_group_id: member.familyGroupId, r2_key: "x", uploaded_by: member.personId })
        .returning("*");
      const res = await ctx
        .request()
        .post("/api/v1/invitations")
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({
          name: "Aunt Sophie",
          relationshipType: "other",
          relatedToPersonId: member.personId,
          triggeringPhotoId: photo.id,
        });
      expect(res.status).toBe(201);
    });

    it("blocks a non-administrator from starting a deceased profile", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/persons/deceased")
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ name: "Grandpa Joe", deathDate: "2015-06-01", relationshipType: "parent_of", relatedToPersonId: member.personId });
      expect(res.status).toBe(403);
    });

    it("allows the administrator to start a deceased profile", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/persons/deceased")
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ name: "Grandpa Joe", deathDate: "2015-06-01", relationshipType: "parent_of", relatedToPersonId: admin.personId });
      expect(res.status).toBe(201);
    });

    it("blocks a non-administrator from the moderation flags queue", async () => {
      const res = await ctx.request().get("/api/v1/flags").set("Authorization", `Bearer ${member.accessToken}`);
      expect(res.status).toBe(403);
    });

    it("allows the administrator to read the moderation flags queue", async () => {
      const res = await ctx.request().get("/api/v1/flags").set("Authorization", `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
    });

    it("blocks a non-administrator from requesting a memory restore", async () => {
      const [memory] = await ctx
        .knex()("memories")
        .insert({
          family_group_id: member.familyGroupId,
          contributor_id: admin.personId,
          content: "x",
          provenance_type: "text",
          retracted: true,
          retracted_at: new Date(),
        })
        .returning("*");
      const res = await ctx
        .request()
        .post(`/api/v1/memories/${memory.id}/restore-request`)
        .set("Authorization", `Bearer ${member.accessToken}`);
      expect(res.status).toBe(403);
    });

    describe("voice-model pause/revoke — self or administrator", () => {
      it("lets a member pause their own voice model without being the administrator", async () => {
        await ctx.knex()("voice_models").insert({ person_id: member.personId, consent_status: "consented", tier: "instant" });
        const res = await ctx
          .request()
          .post(`/api/v1/persons/${member.personId}/voice-model/pause`)
          .set("Authorization", `Bearer ${member.accessToken}`);
        expect(res.status).toBe(200);
      });

      it("blocks a non-administrator member from pausing someone else's voice model", async () => {
        await ctx.knex()("voice_models").insert({ person_id: admin.personId, consent_status: "consented", tier: "instant" });
        const res = await ctx
          .request()
          .post(`/api/v1/persons/${admin.personId}/voice-model/pause`)
          .set("Authorization", `Bearer ${member.accessToken}`);
        expect(res.status).toBe(403);
      });

      it("lets the administrator pause someone else's voice model", async () => {
        await ctx.knex()("voice_models").insert({ person_id: member.personId, consent_status: "consented", tier: "instant" });
        const res = await ctx
          .request()
          .post(`/api/v1/persons/${member.personId}/voice-model/pause`)
          .set("Authorization", `Bearer ${admin.accessToken}`);
        expect(res.status).toBe(200);
      });
    });
  });

  describe("GET /family/administrator", () => {
    it("returns the current administrator", async () => {
      const res = await ctx.request().get("/api/v1/family/administrator").set("Authorization", `Bearer ${member.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.administrator.personId).toBe(admin.personId);
    });
  });

  describe("POST /family/administrator/transfer", () => {
    it("rejects a transfer requested by a non-administrator", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/family/administrator/transfer")
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ toPersonId: admin.personId });
      expect(res.status).toBe(403);
    });

    it("transfers the role, clearing the old administrator and setting the new one", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/family/administrator/transfer")
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ toPersonId: member.personId });
      expect(res.status).toBe(200);
      expect(res.body.administrator.personId).toBe(member.personId);

      const oldAdminRow = await ctx.knex()("persons").where({ id: admin.personId }).first();
      expect(oldAdminRow.family_role).toBeNull();
      const newAdminRow = await ctx.knex()("persons").where({ id: member.personId }).first();
      expect(newAdminRow.family_role).toBe("administrator");

      // the old administrator has genuinely lost the role now
      const followUp = await ctx
        .request()
        .get("/api/v1/flags")
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(followUp.status).toBe(403);
    });

    it("rejects transferring to a non-active person", async () => {
      const invite = await ctx
        .request()
        .post("/api/v1/invitations")
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ name: "Pending Person", relationshipType: "other", relatedToPersonId: admin.personId });

      const res = await ctx
        .request()
        .post("/api/v1/family/administrator/transfer")
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ toPersonId: invite.body.person.id });
      expect(res.status).toBe(409);
    });

    it("404s transferring to someone outside the family group", async () => {
      const outsider = await registerTestUser(ctx.request);
      const res = await ctx
        .request()
        .post("/api/v1/family/administrator/transfer")
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ toPersonId: outsider.personId });
      expect(res.status).toBe(404);
    });
  });
});

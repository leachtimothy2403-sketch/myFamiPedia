import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

// docs/photo_pipeline_beta_architecture.md sections 2, 4, 8 — tap-to-tag's
// three branches (existing active person, existing still-pending person,
// brand-new person via admin-approval proposal), crowd-mode's threshold
// flag, and the admin-only proposal queue.
describe("photos — tap-to-tag", () => {
  const ctx = withApp();
  let admin: TestUser;
  let member: TestUser;

  beforeEach(async () => {
    admin = await registerTestUser(ctx.request);
    member = await registerTestUser(ctx.request, { familyGroupId: admin.familyGroupId });
  });

  async function seedPhotoWithFaces(count = 1) {
    const knex = ctx.knex();
    const [photo] = await knex("photos")
      .insert({ family_group_id: admin.familyGroupId, r2_key: "p.jpg", uploaded_by: admin.personId, face_count: count })
      .returning("*");
    const faces = await knex("photo_faces")
      .insert(
        Array.from({ length: count }, (_, i) => ({
          photo_id: photo.id,
          face_coordinates: JSON.stringify({ left: i * 0.1, top: 0, width: 0.1, height: 0.1 }),
          confidence: 95,
        }))
      )
      .returning("*");
    return { photo, faces };
  }

  describe("GET /photos/:id/faces", () => {
    it("returns tap targets with tag=null for untagged faces and crowdMode=false under the threshold", async () => {
      const { photo } = await seedPhotoWithFaces(2);
      const res = await ctx.request().get(`/api/v1/photos/${photo.id}/faces`).set("Authorization", `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.faces).toHaveLength(2);
      expect(res.body.faces[0].tag).toBeNull();
      expect(res.body.crowdMode).toBe(false);
    });

    it("flags crowdMode once face_count exceeds the threshold", async () => {
      const { photo } = await seedPhotoWithFaces(9);
      const res = await ctx.request().get(`/api/v1/photos/${photo.id}/faces`).set("Authorization", `Bearer ${admin.accessToken}`);
      expect(res.body.crowdMode).toBe(true);
    });

    it("404s for a photo that doesn't exist", async () => {
      const res = await ctx
        .request()
        .get(`/api/v1/photos/00000000-0000-0000-0000-000000000000/faces`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /photos/:id/faces/:faceId/tag", () => {
    it("branch (a): tags an active person directly", async () => {
      const { photo, faces } = await seedPhotoWithFaces();
      const res = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ personId: admin.personId });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe("tagged");

      const tag = await ctx.knex()("photo_persons").where({ face_id: faces[0].id }).first();
      expect(tag.person_id).toBe(admin.personId);
      expect(tag.identification_status).toBe("confirmed");
      expect(tag.tagged_by).toBe(member.personId);
    });

    it("branch (a) with memoryId: also attaches memory_persons and memory_photos to the in-progress memory", async () => {
      const { photo, faces } = await seedPhotoWithFaces();
      const [memory] = await ctx
        .knex()("memories")
        .insert({ family_group_id: admin.familyGroupId, contributor_id: admin.personId, provenance_type: "photo" })
        .returning("*");

      const res = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ personId: admin.personId, memoryId: memory.id });
      expect(res.status).toBe(201);

      const memoryPersons = await ctx.knex()("memory_persons").where({ memory_id: memory.id });
      expect(memoryPersons.map((p: { person_id: string }) => p.person_id)).toContain(admin.personId);
      const memoryPhotos = await ctx.knex()("memory_photos").where({ memory_id: memory.id });
      expect(memoryPhotos.map((p: { photo_id: string }) => p.photo_id)).toContain(photo.id);
    });

    it("branch (b): tagging a still-pending person writes to holding_space instead of photo_persons", async () => {
      const { photo, faces } = await seedPhotoWithFaces();
      const [pending] = await ctx
        .knex()("persons")
        .insert({ family_group_id: admin.familyGroupId, name: "Pending Cousin", status: "invited_pending" })
        .returning("*");

      const res = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ personId: pending.id });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe("held");

      expect(await ctx.knex()("photo_persons").where({ face_id: faces[0].id })).toHaveLength(0);
      const held = await ctx.knex()("holding_space").where({ person_id: pending.id }).first();
      expect(held.media_type).toBe("photo");
      expect(held.raw_metadata.faceId).toBe(faces[0].id);
    });

    it("branch (c): an unrecognized face creates an admin-approval proposal, not a person or invitation", async () => {
      const { photo, faces } = await seedPhotoWithFaces();
      const res = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ newPersonName: "New Baby", relatedToPersonId: admin.personId, relationshipType: "child" });
      expect(res.status).toBe(202);
      expect(res.body.kind).toBe("proposal");

      const proposal = await ctx.knex()("person_tag_proposals").where({ face_id: faces[0].id }).first();
      expect(proposal.status).toBe("pending");
      expect(proposal.proposed_by_person_id).toBe(member.personId);
      const personCount = await ctx.knex()("persons").where({ name: "New Baby" });
      expect(personCount).toHaveLength(0);
    });

    it("rejects tagging a face that's already been confirmed (add-only, not edit)", async () => {
      const { photo, faces } = await seedPhotoWithFaces();
      await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ personId: admin.personId });

      const res = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ personId: member.personId });
      expect(res.status).toBe(409);
    });

    it("rejects a second proposal on a face with one already pending", async () => {
      const { photo, faces } = await seedPhotoWithFaces();
      await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ newPersonName: "Baby A", relatedToPersonId: admin.personId, relationshipType: "child" });

      const res = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ newPersonName: "Baby B", relatedToPersonId: admin.personId, relationshipType: "child" });
      expect(res.status).toBe(409);
    });

    it("400s when neither personId nor newPersonName is given", async () => {
      const { photo, faces } = await seedPhotoWithFaces();
      const res = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("admin-approval queue for new-person proposals", () => {
    async function createProposal() {
      const { photo, faces } = await seedPhotoWithFaces();
      const tagRes = await ctx
        .request()
        .post(`/api/v1/photos/${photo.id}/faces/${faces[0].id}/tag`)
        .set("Authorization", `Bearer ${member.accessToken}`)
        .send({ newPersonName: "New Baby", relatedToPersonId: admin.personId, relationshipType: "child" });
      return tagRes.body.proposal;
    }

    it("blocks a non-administrator from listing or resolving proposals", async () => {
      const proposal = await createProposal();
      const listRes = await ctx.request().get("/api/v1/person-tag-proposals").set("Authorization", `Bearer ${member.accessToken}`);
      expect(listRes.status).toBe(403);

      const approveRes = await ctx
        .request()
        .post(`/api/v1/person-tag-proposals/${proposal.id}/approve`)
        .set("Authorization", `Bearer ${member.accessToken}`);
      expect(approveRes.status).toBe(403);
    });

    it("lets the administrator approve a proposal, creating the person + invitation with the ORIGINAL TAGGER as inviter", async () => {
      const proposal = await createProposal();
      const res = await ctx
        .request()
        .post(`/api/v1/person-tag-proposals/${proposal.id}/approve`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(201);
      expect(res.body.person.name).toBe("New Baby");
      expect(res.body.invitation.invited_by_person_id).toBe(member.personId);

      const updated = await ctx.knex()("person_tag_proposals").where({ id: proposal.id }).first();
      expect(updated.status).toBe("approved");
      const held = await ctx.knex()("holding_space").where({ person_id: res.body.person.id }).first();
      expect(held).toBeDefined();
    });

    it("lets the administrator reject a proposal without creating a person", async () => {
      const proposal = await createProposal();
      const res = await ctx
        .request()
        .post(`/api/v1/person-tag-proposals/${proposal.id}/reject`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(204);

      const updated = await ctx.knex()("person_tag_proposals").where({ id: proposal.id }).first();
      expect(updated.status).toBe("rejected");
      expect(await ctx.knex()("persons").where({ name: "New Baby" })).toHaveLength(0);
    });
  });
});

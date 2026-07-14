import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

describe("invitations", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  it("creates a person + relationship + invitation, with a shareable link when no contact info given", async () => {
    const res = await ctx
      .request()
      .post("/api/v1/invitations")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "Cousin Jo", relationshipType: "other", relatedToPersonId: user.personId });

    expect(res.status).toBe(201);
    expect(res.body.person.status).toBe("invited_pending");
    expect(res.body.invitation.status).toBe("pending");
    expect(res.body.shareableLink).toContain(res.body.invitation.token);

    const rel = await ctx
      .knex()("relationships")
      .where({ person_a_id: user.personId, person_b_id: res.body.person.id })
      .first();
    expect(rel).toBeDefined();
  });

  it("omits the shareable link when an email is given", async () => {
    const res = await ctx
      .request()
      .post("/api/v1/invitations")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "Aunt May", relationshipType: "other", relatedToPersonId: user.personId, inviteeEmail: "may@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.shareableLink).toBeUndefined();
  });

  it("requires name, relationshipType, and relatedToPersonId", async () => {
    const res = await ctx
      .request()
      .post("/api/v1/invitations")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "Nobody" });
    expect(res.status).toBe(400);
  });

  async function createInvitation() {
    const res = await ctx
      .request()
      .post("/api/v1/invitations")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "Cousin Jo", relationshipType: "other", relatedToPersonId: user.personId });
    return res.body as { person: { id: string }; invitation: { id: string; token: string } };
  }

  it("public GET /invitations/:token works without auth", async () => {
    const { invitation, person } = await createInvitation();
    const res = await ctx.request().get(`/api/v1/invitations/${invitation.token}`);
    expect(res.status).toBe(200);
    expect(res.body.person.name).toBe("Cousin Jo");
    expect(res.body.invitation.token).toBe(invitation.token);
    void person;
  });

  it("404s a bogus token", async () => {
    const res = await ctx.request().get(`/api/v1/invitations/not-a-real-token`);
    expect(res.status).toBe(404);
  });

  it("accept moves person to active and enqueues a holding-space drain", async () => {
    const { invitation, person } = await createInvitation();
    const res = await ctx.request().post(`/api/v1/invitations/${invitation.token}/accept`);
    expect(res.status).toBe(204);

    const updatedPerson = await ctx.knex()("persons").where({ id: person.id }).first();
    expect(updatedPerson.status).toBe("active");
    const updatedInvitation = await ctx.knex()("invitations").where({ id: invitation.id }).first();
    expect(updatedInvitation.status).toBe("accepted");

    expect(getQueueMock("holdingSpaceQueue").add).toHaveBeenCalledWith("drain", { personId: person.id });
  });

  it("rejects accepting an already-accepted invitation", async () => {
    const { invitation } = await createInvitation();
    await ctx.request().post(`/api/v1/invitations/${invitation.token}/accept`);
    const res = await ctx.request().post(`/api/v1/invitations/${invitation.token}/accept`);
    expect(res.status).toBe(409);
  });

  it("decline sets declined_grace + a 90-day grace period", async () => {
    const { invitation, person } = await createInvitation();
    const res = await ctx.request().post(`/api/v1/invitations/${invitation.token}/decline`);
    expect(res.status).toBe(204);

    const updatedPerson = await ctx.knex()("persons").where({ id: person.id }).first();
    expect(updatedPerson.status).toBe("declined_grace");
    const updatedInvitation = await ctx.knex()("invitations").where({ id: invitation.id }).first();
    expect(updatedInvitation.status).toBe("declined");
    expect(updatedInvitation.grace_period_end).not.toBeNull();
    const daysAhead = (new Date(updatedInvitation.grace_period_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysAhead).toBeGreaterThan(89);
    expect(daysAhead).toBeLessThan(91);
  });

  describe("reinvite", () => {
    it("allows exactly one reinvite by the original inviter", async () => {
      const { invitation } = await createInvitation();
      await ctx.request().post(`/api/v1/invitations/${invitation.token}/decline`);

      const res = await ctx
        .request()
        .post(`/api/v1/invitations/${invitation.id}/reinvite`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(201);
      expect(res.body.token).not.toBe(invitation.token);

      const original = await ctx.knex()("invitations").where({ id: invitation.id }).first();
      expect(original.reinvited).toBe(true);

      const second = await ctx
        .request()
        .post(`/api/v1/invitations/${invitation.id}/reinvite`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(second.status).toBe(409);
    });

    it("rejects reinvite from someone other than the original inviter", async () => {
      const { invitation } = await createInvitation();
      await ctx.request().post(`/api/v1/invitations/${invitation.token}/decline`);
      const other = await registerTestUser(ctx.request);
      const res = await ctx
        .request()
        .post(`/api/v1/invitations/${invitation.id}/reinvite`)
        .set("Authorization", `Bearer ${other.accessToken}`);
      expect(res.status).toBe(403);
    });

    it("rejects reinvite while still pending", async () => {
      const { invitation } = await createInvitation();
      const res = await ctx
        .request()
        .post(`/api/v1/invitations/${invitation.id}/reinvite`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });
  });

  describe("opt-out", () => {
    it("sets opted_out and blurs existing face tags", async () => {
      const [photo] = await ctx.knex()("photos").insert({ family_group_id: user.familyGroupId, r2_key: "x", uploaded_by: user.personId }).returning("*");
      await ctx.knex()("photo_persons").insert({ photo_id: photo.id, person_id: user.personId });

      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/opt-out`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const person = await ctx.knex()("persons").where({ id: user.personId }).first();
      expect(person.status).toBe("opted_out");
      const tag = await ctx.knex()("photo_persons").where({ photo_id: photo.id, person_id: user.personId }).first();
      expect(tag.face_blurred).toBe(true);

      expect(getQueueMock("faceDetectionQueue").add).toHaveBeenCalledWith("remove-from-collection", { personId: user.personId });
    });

    it("rejects opting out someone else", async () => {
      const other = await registerTestUser(ctx.request);
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${other.personId}/opt-out`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(403);
    });
  });

  // NOTE: the underlying holding_space_owner_only RLS policy is what's
  // actually supposed to restrict this count to rows the caller themself
  // added (source_person_id = caller) — but this test harness's pglite
  // connection is always a superuser, which always bypasses RLS (see
  // tests/helpers/testDb.ts). So this only exercises the query returning
  // *a* count; it deliberately does NOT assert the owner-only filtering,
  // since that would pass even if the policy were wrong. Policy correctness
  // was reviewed manually against docs/privacy_enforcement.md.
  it("returns a holding-space count for the given person", async () => {
    const { person } = await createInvitation();
    await ctx.knex()("holding_space").insert([
      { person_id: person.id, source_person_id: user.personId, media_type: "photo" },
      { person_id: person.id, source_person_id: user.personId, media_type: "mention" },
    ]);

    const res = await ctx
      .request()
      .get(`/api/v1/persons/${person.id}/holding-space-count`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

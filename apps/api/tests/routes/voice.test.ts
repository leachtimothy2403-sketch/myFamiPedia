import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

describe("voice consent", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  it("GET returns a none-state default when no voice_models row exists", async () => {
    const res = await ctx
      .request()
      .get(`/api/v1/persons/${user.personId}/voice-model`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.consentStatus ?? res.body.consent_status).toBe("none");
  });

  describe("preview", () => {
    it("creates a voice_models row in previewed state and queues generation", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/preview`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.consent_status).toBe("previewed");
      expect(getQueueMock("voiceCloningQueue").add).toHaveBeenCalledWith("generate-preview", { personId: user.personId });
    });

    it("can be triggered by someone else (facilitator running a session)", async () => {
      const facilitator = await registerTestUser(ctx.request);
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/preview`)
        .set("Authorization", `Bearer ${facilitator.accessToken}`);
      expect(res.status).toBe(200);
    });

    it("does not downgrade an already-consented model back to previewed", async () => {
      await ctx.knex()("voice_models").insert({ person_id: user.personId, consent_status: "consented", tier: "instant" });
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/preview`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.body.consent_status).toBe("consented");
    });
  });

  describe("consent", () => {
    it("grants consent, self only", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/consent`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ consented: true });
      expect(res.status).toBe(200);
      expect(res.body.consent_status).toBe("consented");
      expect(res.body.consented_by).toBe(user.personId);
      expect(res.body.consent_date).not.toBeNull();
    });

    it("rejects consent given by someone other than the subject", async () => {
      const other = await registerTestUser(ctx.request);
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/consent`)
        .set("Authorization", `Bearer ${other.accessToken}`)
        .send({ consented: true });
      expect(res.status).toBe(403);
    });

    it("treats consented:false as revoke ('No, never')", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/consent`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ consented: false });
      expect(res.status).toBe(200);
      expect(res.body.consent_status).toBe("revoked");
    });

    it("blocks consenting for a person who has died", async () => {
      await ctx.knex()("persons").where({ id: user.personId }).update({ death_date: "2020-01-01" });
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/consent`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ consented: true });
      expect(res.status).toBe(403);
    });

    it("requires a boolean consented field", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/consent`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("pause / revoke", () => {
    it("pauses an existing model", async () => {
      await ctx.knex()("voice_models").insert({ person_id: user.personId, consent_status: "consented", tier: "instant" });
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/pause`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.consent_status).toBe("paused");
    });

    it("404s pausing a person with no voice model yet", async () => {
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/pause`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(404);
    });

    it("revokes and queues ElevenLabs model deletion", async () => {
      await ctx.knex()("voice_models").insert({ person_id: user.personId, consent_status: "consented", tier: "instant" });
      const res = await ctx
        .request()
        .post(`/api/v1/persons/${user.personId}/voice-model/revoke`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.consent_status).toBe("revoked");
      expect(getQueueMock("voiceCloningQueue").add).toHaveBeenCalledWith("delete-model", { personId: user.personId });
    });
  });
});

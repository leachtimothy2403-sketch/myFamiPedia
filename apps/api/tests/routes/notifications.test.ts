import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("notifications", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  it("lists this user's notifications only", async () => {
    const other = await registerTestUser(ctx.request);
    await ctx.knex()("notifications").insert([
      { user_id: user.userId, type: "memory_retracted", payload: JSON.stringify({}) },
      { user_id: other.userId, type: "memory_retracted", payload: JSON.stringify({}) },
    ]);
    const res = await ctx.request().get("/api/v1/notifications").set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("gets and patches notification settings", async () => {
    const getRes = await ctx.request().get("/api/v1/notifications/settings").set("Authorization", `Bearer ${user.accessToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.items).toHaveLength(0);

    const patchRes = await ctx
      .request()
      .patch("/api/v1/notifications/settings")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ notificationType: "manual_tier_nudge", enabled: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.enabled).toBe(false);

    // upsert: patching again updates rather than duplicating
    const patchAgain = await ctx
      .request()
      .patch("/api/v1/notifications/settings")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ notificationType: "manual_tier_nudge", enabled: true });
    expect(patchAgain.body.enabled).toBe(true);

    const finalGet = await ctx.request().get("/api/v1/notifications/settings").set("Authorization", `Bearer ${user.accessToken}`);
    expect(finalGet.body.items).toHaveLength(1);
  });

  it("validates the settings patch body", async () => {
    const res = await ctx
      .request()
      .patch("/api/v1/notifications/settings")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ notificationType: "x" });
    expect(res.status).toBe(400);
  });
});

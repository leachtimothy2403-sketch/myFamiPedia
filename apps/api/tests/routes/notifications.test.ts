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
    // GET merges a fixed list of notification types against whatever
    // per-user override rows exist (notifications.routes.ts) — a user who's
    // never touched their settings still gets the full list back, all
    // defaulting to enabled: true, not an empty array.
    const getRes = await ctx.request().get("/api/v1/notifications/settings").set("Authorization", `Bearer ${user.accessToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.items.length).toBeGreaterThan(0);
    expect(getRes.body.items.every((i: { enabled: boolean }) => i.enabled === true)).toBe(true);
    const typeCount = getRes.body.items.length;

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

    // Still the same full merged list — one override doesn't shrink it.
    const finalGet = await ctx.request().get("/api/v1/notifications/settings").set("Authorization", `Bearer ${user.accessToken}`);
    expect(finalGet.body.items).toHaveLength(typeCount);
    const nudge = finalGet.body.items.find((i: { notificationType: string }) => i.notificationType === "manual_tier_nudge");
    expect(nudge.enabled).toBe(true);
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

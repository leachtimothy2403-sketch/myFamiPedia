import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("subscription", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  it("reads subscription status for the caller's own family group", async () => {
    const res = await ctx
      .request()
      .get(`/api/v1/family-groups/${user.familyGroupId}/subscription`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("rejects reading another family group's subscription", async () => {
    const other = await registerTestUser(ctx.request);
    const res = await ctx
      .request()
      .get(`/api/v1/family-groups/${other.familyGroupId}/subscription`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("takeover sets the caller as paying member and resets grace/cold-storage", async () => {
    await ctx.knex()("family_groups").where({ id: user.familyGroupId }).update({
      subscription_status: "grace",
      grace_period_end: new Date(),
    });

    const res = await ctx
      .request()
      .post(`/api/v1/family-groups/${user.familyGroupId}/subscription/takeover`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.payingMemberId).toBe(user.userId);

    const group = await ctx.knex()("family_groups").where({ id: user.familyGroupId }).first();
    expect(group.grace_period_end).toBeNull();
  });

  it("rejects taking over another family group's subscription", async () => {
    const other = await registerTestUser(ctx.request);
    const res = await ctx
      .request()
      .post(`/api/v1/family-groups/${other.familyGroupId}/subscription/takeover`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(403);
  });
});

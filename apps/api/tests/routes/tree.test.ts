import { describe, it, expect } from "vitest";
import { withApp, registerTestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("family tree", () => {
  const ctx = withApp();

  it("returns the registering person as the sole node in a fresh family group", async () => {
    const user = await registerTestUser(ctx.request);
    const res = await ctx
      .request()
      .get(`/api/v1/family-groups/${user.familyGroupId}/tree`)
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.persons).toHaveLength(1);
    expect(res.body.persons[0].id).toBe(user.personId);
    expect(res.body.relationships).toHaveLength(0);
  });

  it("requires auth", async () => {
    const user = await registerTestUser(ctx.request);
    const res = await ctx.request().get(`/api/v1/family-groups/${user.familyGroupId}/tree`);
    expect(res.status).toBe(401);
  });

  it("includes added relatives and their relationships", async () => {
    const user = await registerTestUser(ctx.request);
    const [spouse] = await ctx
      .knex()("persons")
      .insert({ family_group_id: user.familyGroupId, name: "Spouse", status: "active" })
      .returning("*");
    await ctx.knex()("relationships").insert({
      person_a_id: user.personId,
      person_b_id: spouse.id,
      relationship_type: "spouse_of",
    });

    const res = await ctx
      .request()
      .get(`/api/v1/family-groups/${user.familyGroupId}/tree`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.body.persons).toHaveLength(2);
    expect(res.body.relationships).toHaveLength(1);
  });
});

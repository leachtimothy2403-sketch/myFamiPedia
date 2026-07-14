import { describe, it, expect, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("search", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  async function memory(overrides: Record<string, unknown>) {
    const [m] = await ctx
      .knex()("memories")
      .insert({ family_group_id: user.familyGroupId, contributor_id: user.personId, provenance_type: "text", ...overrides })
      .returning("*");
    return m;
  }

  it("finds a memory by keyword in its content", async () => {
    await memory({ content: "We went camping by the lake in summer" });
    await memory({ content: "Grandma's apple pie recipe" });

    const res = await ctx
      .request()
      .get("/api/v1/search?q=camping&mode=keyword")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].content).toContain("camping");
  });

  it("requires q", async () => {
    const res = await ctx.request().get("/api/v1/search?mode=keyword").set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(400);
  });

  it("501s semantic mode rather than silently falling back", async () => {
    const res = await ctx.request().get("/api/v1/search?q=x&mode=semantic").set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(501);
  });

  it("filters by date range and provenance/media type", async () => {
    await memory({ content: "birthday party", event_date: "2015-06-01", provenance_type: "text" });
    await memory({ content: "birthday cake", event_date: "2022-06-01", provenance_type: "photo" });

    const dateFiltered = await ctx
      .request()
      .get("/api/v1/search?q=birthday&date_from=2020-01-01")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(dateFiltered.body.items).toHaveLength(1);
    expect(dateFiltered.body.items[0].content).toBe("birthday cake");

    const typeFiltered = await ctx
      .request()
      .get("/api/v1/search?q=birthday&media_type=text")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(typeFiltered.body.items).toHaveLength(1);
    expect(typeFiltered.body.items[0].content).toBe("birthday party");
  });

  // migration 013 fixed a real cross-tenant leak: memory_privacy and
  // photo_privacy never checked family_group_id, so any public
  // (is_private=false) row was visible to every authenticated person in
  // every family group, not just its own. The scenario that would have
  // exposed this — a public memory in family B showing up in family A's
  // search — can't actually be exercised as a test through this harness:
  // pglite's connection is always a Postgres superuser (see
  // tests/helpers/testDb.ts), and superusers always bypass RLS regardless
  // of the policy, so the leaky pre-fix version and the fixed version
  // behave IDENTICALLY here (both would return both families' rows). A test
  // asserting "only 1 result" would pass or fail for the wrong reason either
  // way — false confidence, not real coverage.
  //
  // What CAN be verified without RLS enforcement: that the fix actually
  // landed in the database as the intended policy, by reading Postgres's
  // own policy catalog rather than relying on enforcement behavior.
  it("memory_privacy and photo_privacy policies include a family_group_id check (migration 013)", async () => {
    const policies = await ctx
      .knex()
      .raw(
        `SELECT policyname, qual FROM pg_policies WHERE tablename IN ('memories', 'photos') AND policyname IN ('memory_privacy', 'photo_privacy')`
      );
    expect(policies.rows).toHaveLength(2);
    for (const policy of policies.rows) {
      expect(policy.qual).toContain("family_group_id");
    }
  });

  it("decades view groups memories by decade", async () => {
    await memory({ content: "a", event_date: "1985-05-01" });
    await memory({ content: "b", event_date: "1988-05-01" });
    await memory({ content: "c", event_date: "2021-05-01" });

    const res = await ctx
      .request()
      .get(`/api/v1/family-groups/${user.familyGroupId}/decades`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const counts = res.body.items.map((i: { count: string }) => Number(i.count)).sort();
    expect(counts).toEqual([1, 2]);
  });

  it("rejects reading another family group's decades view", async () => {
    const other = await registerTestUser(ctx.request);
    const res = await ctx
      .request()
      .get(`/api/v1/family-groups/${other.familyGroupId}/decades`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(403);
  });
});

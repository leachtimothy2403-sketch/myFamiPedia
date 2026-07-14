import { describe, it, expect } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();

describe("notification worker", () => {
  const ctx = withDb();

  async function seedPersonWithUser(overrides: { userId?: string } = {}) {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [user] = await knex("users").insert({ email: `u-${Math.random()}@test.com` }).returning("*");
    const [person] = await knex("persons")
      .insert({ family_group_id: group.id, user_id: overrides.userId ?? user.id, name: "Alice", status: "active" })
      .returning("*");
    return { group, user, person };
  }

  it("writes a notifications row for a recipient with a linked user account", async () => {
    const { processNotificationJob } = await import("../../src/jobs/notification.worker");
    const { person, user } = await seedPersonWithUser();

    await processNotificationJob({
      recipientPersonId: person.id,
      type: "memory_retracted",
      payload: { memoryId: "abc" },
    });

    const rows = await ctx.knex()("notifications").where({ user_id: user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("memory_retracted");
    expect(rows[0].payload).toMatchObject({ memoryId: "abc" });
  });

  it("is a no-op for a recipient with no linked user account (e.g. still invited_pending)", async () => {
    const { processNotificationJob } = await import("../../src/jobs/notification.worker");
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [pending] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Pending Bob", status: "invited_pending" })
      .returning("*");

    await expect(
      processNotificationJob({ recipientPersonId: pending.id, type: "memory_retracted", payload: {} })
    ).resolves.toBeUndefined();
    const rows = await knex("notifications");
    expect(rows).toHaveLength(0);
  });

  it("honors a disabled notification_settings row for that type", async () => {
    const { processNotificationJob } = await import("../../src/jobs/notification.worker");
    const { person, user } = await seedPersonWithUser();
    await ctx.knex()("notification_settings").insert({
      user_id: user.id,
      notification_type: "memory_retracted",
      enabled: false,
    });

    await processNotificationJob({ recipientPersonId: person.id, type: "memory_retracted", payload: {} });

    const rows = await ctx.knex()("notifications").where({ user_id: user.id });
    expect(rows).toHaveLength(0);
  });
});

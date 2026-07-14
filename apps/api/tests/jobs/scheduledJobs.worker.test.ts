import { describe, it, expect, vi, beforeEach } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

const FIXED_NOW = new Date("2026-07-14T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const fixedDeps = { deleteObject: vi.fn(), now: () => FIXED_NOW };

describe("scheduled jobs (Q_CRON daily sweep)", () => {
  const ctx = withDb();

  beforeEach(async () => {
    // Dynamically importing the (mocked) queue module first guarantees
    // vi.mock's factory has populated fakeQueues before getQueueMock reads
    // from it — the factory only runs on first import, which otherwise
    // wouldn't happen until a worker module is dynamically imported inside
    // an individual `it` block below.
    await import("../../src/jobs/queue");
    getQueueMock("notificationQueue").add.mockClear();
  });

  async function seedFamily() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    return group;
  }

  describe("sweepExpiredInvitations", () => {
    it("opts out the person, deletes their holding space, and marks the invitation expired", async () => {
      const { sweepExpiredInvitations } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      const [inviter] = await knex("persons").insert({ family_group_id: group.id, name: "Inviter", status: "active" }).returning("*");
      const [pending] = await knex("persons")
        .insert({ family_group_id: group.id, name: "Never Joined", status: "declined_grace" })
        .returning("*");
      const [invitation] = await knex("invitations")
        .insert({
          person_id: pending.id,
          invited_by_person_id: inviter.id,
          token: "expired-token",
          status: "declined",
          grace_period_end: new Date(FIXED_NOW.getTime() - DAY_MS),
        })
        .returning("*");
      await knex("holding_space").insert({ person_id: pending.id, source_person_id: inviter.id, media_type: "photo", r2_key: "holding/x.jpg" });

      const result = await sweepExpiredInvitations(fixedDeps);
      expect(result.expiredCount).toBe(1);

      const refreshedPerson = await knex("persons").where({ id: pending.id }).first();
      expect(refreshedPerson.status).toBe("opted_out");
      const remainingHolding = await knex("holding_space").where({ person_id: pending.id });
      expect(remainingHolding).toHaveLength(0);
      const refreshedInvitation = await knex("invitations").where({ id: invitation.id }).first();
      expect(refreshedInvitation.status).toBe("expired");
    });

    it("leaves a still-within-grace-period declined invitation untouched", async () => {
      const { sweepExpiredInvitations } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      const [inviter] = await knex("persons").insert({ family_group_id: group.id, name: "Inviter", status: "active" }).returning("*");
      const [pending] = await knex("persons")
        .insert({ family_group_id: group.id, name: "Still Waiting", status: "declined_grace" })
        .returning("*");
      await knex("invitations").insert({
        person_id: pending.id,
        invited_by_person_id: inviter.id,
        token: "not-expired-token",
        status: "declined",
        grace_period_end: new Date(FIXED_NOW.getTime() + 10 * DAY_MS),
      });

      const result = await sweepExpiredInvitations(fixedDeps);
      expect(result.expiredCount).toBe(0);
      const refreshed = await knex("persons").where({ id: pending.id }).first();
      expect(refreshed.status).toBe("declined_grace");
    });
  });

  describe("sweepSubscriptionLifecycle", () => {
    it("moves an expired grace group to cold_storage", async () => {
      const { sweepSubscriptionLifecycle } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const [group] = await knex("family_groups")
        .insert({ name: "Lapsed", subscription_status: "grace", grace_period_end: new Date(FIXED_NOW.getTime() - DAY_MS) })
        .returning("*");

      const result = await sweepSubscriptionLifecycle(fixedDeps);
      expect(result.movedToColdStorage).toBe(1);
      const refreshed = await knex("family_groups").where({ id: group.id }).first();
      expect(refreshed.subscription_status).toBe("cold_storage");
      expect(refreshed.cold_storage_end).toBeTruthy();
    });

    it("moves an expired cold_storage group to deleted", async () => {
      const { sweepSubscriptionLifecycle } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const [group] = await knex("family_groups")
        .insert({ name: "Long Gone", subscription_status: "cold_storage", cold_storage_end: new Date(FIXED_NOW.getTime() - DAY_MS) })
        .returning("*");

      await sweepSubscriptionLifecycle(fixedDeps);
      const refreshed = await knex("family_groups").where({ id: group.id }).first();
      expect(refreshed.subscription_status).toBe("deleted");
    });

    it("notifies the paying member at a day-30 grace checkpoint", async () => {
      const { sweepSubscriptionLifecycle } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const [user] = await knex("users").insert({ email: "payer@test.com" }).returning("*");
      const graceStart = new Date(FIXED_NOW.getTime() - 30 * DAY_MS);
      const graceEnd = new Date(graceStart.getTime() + 90 * DAY_MS);
      const [group] = await knex("family_groups")
        .insert({ name: "Day 30", subscription_status: "grace", grace_period_end: graceEnd, paying_member_id: user.id })
        .returning("*");
      const [person] = await knex("persons")
        .insert({ family_group_id: group.id, user_id: user.id, name: "Payer", status: "active" })
        .returning("*");

      await sweepSubscriptionLifecycle(fixedDeps);
      expect(getQueueMock("notificationQueue").add).toHaveBeenCalledWith(
        "subscription_grace_notice",
        expect.objectContaining({ recipientPersonId: person.id, payload: { daysElapsed: 30 } })
      );
    });

    it("does not notify on a non-checkpoint day", async () => {
      const { sweepSubscriptionLifecycle } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const [user] = await knex("users").insert({ email: "payer2@test.com" }).returning("*");
      const graceStart = new Date(FIXED_NOW.getTime() - 15 * DAY_MS);
      const graceEnd = new Date(graceStart.getTime() + 90 * DAY_MS);
      const [group] = await knex("family_groups")
        .insert({ name: "Day 15", subscription_status: "grace", grace_period_end: graceEnd, paying_member_id: user.id })
        .returning("*");
      await knex("persons").insert({ family_group_id: group.id, user_id: user.id, name: "Payer", status: "active" });

      await sweepSubscriptionLifecycle(fixedDeps);
      expect(getQueueMock("notificationQueue").add).not.toHaveBeenCalledWith("subscription_grace_notice", expect.anything());
    });
  });

  describe("sweepReviewCardCadence", () => {
    it("notifies a tier-2 person with >=3 pending proposals who hasn't been notified before", async () => {
      const { sweepReviewCardCadence } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      const [person] = await knex("persons")
        .insert({ family_group_id: group.id, name: "Tier2", status: "active", privacy_tier: 2 })
        .returning("*");
      await knex("proposed_memories").insert([
        { person_id: person.id, status: "pending" },
        { person_id: person.id, status: "pending" },
        { person_id: person.id, status: "pending" },
      ]);

      const result = await sweepReviewCardCadence(fixedDeps);
      expect(result.notified).toBe(1);
      expect(getQueueMock("notificationQueue").add).toHaveBeenCalledWith(
        "review_cards_ready",
        expect.objectContaining({ recipientPersonId: person.id, payload: { count: 3 } })
      );
      const refreshed = await knex("persons").where({ id: person.id }).first();
      expect(refreshed.last_review_notification_at).toBeTruthy();
    });

    it("does not re-notify within the cadence window", async () => {
      const { sweepReviewCardCadence } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      const [person] = await knex("persons")
        .insert({
          family_group_id: group.id,
          name: "Tier2 Recently Notified",
          status: "active",
          privacy_tier: 2,
          last_review_notification_at: new Date(FIXED_NOW.getTime() - 1 * DAY_MS),
        })
        .returning("*");
      await knex("proposed_memories").insert([
        { person_id: person.id, status: "pending" },
        { person_id: person.id, status: "pending" },
        { person_id: person.id, status: "pending" },
      ]);

      const result = await sweepReviewCardCadence(fixedDeps);
      expect(result.notified).toBe(0);
    });
  });

  describe("sweepManualTierNudges", () => {
    it("nudges a tier-3 person who's opted in and past the window", async () => {
      const { sweepManualTierNudges } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      const [user] = await knex("users").insert({ email: "tier3@test.com" }).returning("*");
      const [person] = await knex("persons")
        .insert({
          family_group_id: group.id,
          user_id: user.id,
          name: "Tier3",
          status: "active",
          privacy_tier: 3,
          last_manual_add_at: new Date(FIXED_NOW.getTime() - 30 * DAY_MS),
        })
        .returning("*");
      await knex("notification_settings").insert({ user_id: user.id, notification_type: "manual_tier_nudge", enabled: true });

      const result = await sweepManualTierNudges(fixedDeps);
      expect(result.notified).toBe(1);
      expect(getQueueMock("notificationQueue").add).toHaveBeenCalledWith(
        "manual_tier_nudge",
        expect.objectContaining({ recipientPersonId: person.id })
      );
    });

    it("does not nudge without an explicit opt-in (default is off for this type)", async () => {
      const { sweepManualTierNudges } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      const [user] = await knex("users").insert({ email: "tier3b@test.com" }).returning("*");
      await knex("persons").insert({
        family_group_id: group.id,
        user_id: user.id,
        name: "Tier3 No Opt-in",
        status: "active",
        privacy_tier: 3,
        last_manual_add_at: new Date(FIXED_NOW.getTime() - 30 * DAY_MS),
      });

      const result = await sweepManualTierNudges(fixedDeps);
      expect(result.notified).toBe(0);
    });
  });

  describe("sweepQuestionStreamPrompts", () => {
    it("sends the next unanswered question to a due weekly-frequency person", async () => {
      const { sweepQuestionStreamPrompts } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      const [person] = await knex("persons")
        .insert({ family_group_id: group.id, name: "Weekly", status: "active", question_frequency: "weekly" })
        .returning("*");
      const [question] = await knex("interview_questions").insert({ text: "What was your first job?", life_phase: "adulthood", sort_order: 1 }).returning("*");

      const result = await sweepQuestionStreamPrompts(fixedDeps);
      expect(result.notified).toBe(1);
      expect(getQueueMock("notificationQueue").add).toHaveBeenCalledWith(
        "question_prompt_ready",
        expect.objectContaining({ recipientPersonId: person.id, payload: { questionId: question.id, questionText: question.text } })
      );
      const refreshed = await knex("persons").where({ id: person.id }).first();
      expect(refreshed.last_prompt_sent_at).toBeTruthy();
    });

    it("skips a person whose frequency is 'never'", async () => {
      const { sweepQuestionStreamPrompts } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      await knex("persons").insert({ family_group_id: group.id, name: "Opted Out", status: "active", question_frequency: "never" });
      await knex("interview_questions").insert({ text: "Question", life_phase: "adulthood", sort_order: 1 });

      const result = await sweepQuestionStreamPrompts(fixedDeps);
      expect(result.notified).toBe(0);
    });

    it("does not re-send before the frequency interval has passed", async () => {
      const { sweepQuestionStreamPrompts } = await import("../../src/jobs/scheduledJobs.worker");
      const knex = ctx.knex();
      const group = await seedFamily();
      await knex("persons").insert({
        family_group_id: group.id,
        name: "Recently Prompted",
        status: "active",
        question_frequency: "weekly",
        last_prompt_sent_at: new Date(FIXED_NOW.getTime() - 1 * DAY_MS),
      });
      await knex("interview_questions").insert({ text: "Question", life_phase: "adulthood", sort_order: 1 });

      const result = await sweepQuestionStreamPrompts(fixedDeps);
      expect(result.notified).toBe(0);
    });
  });
});

import { Worker, Job } from "bullmq";
import { connection, notificationQueue } from "./queue";
import { withServiceContext } from "../db/pool";
import { deleteObject } from "../services/r2.service";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScheduledJobsDeps {
  deleteObject: (key: string) => Promise<void>;
  now: () => Date;
}
const defaultDeps: ScheduledJobsDeps = { deleteObject, now: () => new Date() };

// docs/invitation_flow.md, "Expiry (90 days, no action)": Q_CRON finds
// declined invitations whose grace period has lapsed. Marks the invitation
// 'expired' (the schema already has this status value; nothing upstream
// sets it, which would otherwise make this sweep reprocess the same row
// forever) as well as flipping the person to opted_out and cleaning up
// their holding space. R2 object deletion is best-effort: not wired up yet
// (see r2.service.ts), and a missing storage integration shouldn't block
// the DB-side cleanup, which is real progress on its own.
export async function sweepExpiredInvitations(deps: ScheduledJobsDeps = defaultDeps) {
  const expired = await withServiceContext((trx) =>
    trx("invitations").where({ status: "declined" }).where("grace_period_end", "<", deps.now())
  );

  for (const invitation of expired) {
    const holdingRows = await withServiceContext((trx) => trx("holding_space").where({ person_id: invitation.person_id }));
    for (const row of holdingRows) {
      if (!row.r2_key) continue;
      try {
        await deps.deleteObject(row.r2_key);
      } catch {
        // Not implemented yet (no R2 credentials wired) — proceed with the
        // DB-side cleanup regardless; see the module doc comment above.
      }
    }
    await withServiceContext(async (trx) => {
      await trx("persons").where({ id: invitation.person_id }).update({ status: "opted_out" });
      await trx("holding_space").where({ person_id: invitation.person_id }).del();
      // Underlying photos rows are untouched — they remain the inviting
      // member's own memories (docs/media_pipeline.md section 4).
      await trx("photo_persons").where({ person_id: invitation.person_id }).del();
      await trx("invitations").where({ id: invitation.id }).update({ status: "expired" });
    });
  }

  return { expiredCount: expired.length };
}

// docs/invitation_flow.md, "Subscription-lifecycle reuse": same daily-sweep
// pattern, family_groups.subscription_status instead of persons.status.
// The doc points at "section 11 of the product doc" for exact day
// thresholds, which isn't one of the files in this repo's docs/ — so, like
// invitation_flow.md's own flagged assumption about re-invite not resetting
// the 90-day clock, this makes an explicit, documented assumption rather
// than guessing silently: cold_storage lasts the same 90 days as the
// invitation grace period (reusing that value since no other is specified),
// and grace-period notifications fire at day 1/30/60/85 as the doc states.
// Actual data deletion once a family group reaches 'deleted' is NOT
// implemented here — purging a family's entire archive without a concrete,
// reviewed spec (and a backup strategy) is too destructive to guess at;
// this only flips the terminal status.
const COLD_STORAGE_DURATION_MS = 90 * DAY_MS;
const GRACE_NOTICE_DAYS = [1, 30, 60, 85];

export async function sweepSubscriptionLifecycle(deps: ScheduledJobsDeps = defaultDeps) {
  const now = deps.now();

  const graceGroups = await withServiceContext((trx) => trx("family_groups").where({ subscription_status: "grace" }));
  let movedToColdStorage = 0;
  for (const group of graceGroups) {
    if (!group.grace_period_end) continue;
    const graceStart = new Date(new Date(group.grace_period_end).getTime() - COLD_STORAGE_DURATION_MS);
    const daysElapsed = Math.floor((now.getTime() - graceStart.getTime()) / DAY_MS);

    if (new Date(group.grace_period_end) < now) {
      await withServiceContext((trx) =>
        trx("family_groups")
          .where({ id: group.id })
          .update({ subscription_status: "cold_storage", cold_storage_end: new Date(now.getTime() + COLD_STORAGE_DURATION_MS) })
      );
      movedToColdStorage++;
      continue;
    }

    if (GRACE_NOTICE_DAYS.includes(daysElapsed) && group.paying_member_id) {
      await notifyPayingMember(group, "subscription_grace_notice", { daysElapsed });
    }
  }

  const coldStorageGroups = await withServiceContext((trx) =>
    trx("family_groups").where({ subscription_status: "cold_storage" }).where("cold_storage_end", "<", now)
  );
  for (const group of coldStorageGroups) {
    await withServiceContext((trx) => trx("family_groups").where({ id: group.id }).update({ subscription_status: "deleted" }));
  }

  return { graceNoticesChecked: graceGroups.length, movedToColdStorage, movedToDeleted: coldStorageGroups.length };
}

// Notifications are keyed by recipientPersonId (see notification.worker.ts),
// but family_groups.paying_member_id is a users.id, not a persons.id — this
// resolves the person row that shares that user account within the same
// family group. If none is found (shouldn't normally happen), the
// notification is silently skipped rather than erroring the whole sweep.
async function notifyPayingMember(group: { id: string; paying_member_id: string }, type: string, payload: Record<string, unknown>) {
  const person = await withServiceContext((trx) =>
    trx("persons").where({ family_group_id: group.id, user_id: group.paying_member_id }).first()
  );
  if (!person) return;
  await notificationQueue.add(type, { recipientPersonId: person.id, type, payload });
}

// docs/section2_pipeline.md section 2: daily batch, tier-2 persons with >=3
// pending proposed_memories, throttled to roughly weekly via
// last_review_notification_at (migration 012).
const REVIEW_CADENCE_DAYS = 6;

export async function sweepReviewCardCadence(deps: ScheduledJobsDeps = defaultDeps) {
  const now = deps.now();
  const candidates = await withServiceContext((trx) =>
    trx("persons as p")
      .join("proposed_memories as pm", "pm.person_id", "p.id")
      .where("p.status", "active")
      .where("p.privacy_tier", 2)
      .where("pm.status", "pending")
      .groupBy("p.id")
      .havingRaw("count(pm.id) >= 3")
      .select("p.id", "p.last_review_notification_at", trx.raw("count(pm.id) AS pending_count"))
  );

  let notified = 0;
  for (const person of candidates) {
    const due =
      !person.last_review_notification_at ||
      now.getTime() - new Date(person.last_review_notification_at).getTime() >= REVIEW_CADENCE_DAYS * DAY_MS;
    if (!due) continue;

    await notificationQueue.add("review_cards_ready", {
      recipientPersonId: person.id,
      type: "review_cards_ready",
      payload: { count: Number(person.pending_count) },
    });
    await withServiceContext((trx) => trx("persons").where({ id: person.id }).update({ last_review_notification_at: now }));
    notified++;
  }
  return { candidateCount: candidates.length, notified };
}

// docs/section2_pipeline.md section 3: tier-3 persons past a randomized
// 14-21 day window since their last manual add, opt-in only (notification_settings
// defaults OFF for this type — unlike every other notification type, whose
// default is ON when no settings row exists — see notification.worker.ts's
// doc comment). last_manual_tier_nudge_sent_at (migration 018) throttles so
// this doesn't fire daily once the window is crossed.
const MANUAL_NUDGE_MIN_DAYS = 14;
const MANUAL_NUDGE_MAX_DAYS = 21;

export async function sweepManualTierNudges(deps: ScheduledJobsDeps = defaultDeps) {
  const now = deps.now();
  const candidates = await withServiceContext((trx) =>
    trx("persons").where({ status: "active", privacy_tier: 3 }).whereNotNull("user_id")
  );

  let notified = 0;
  for (const person of candidates) {
    const sinceLastAdd = person.last_manual_add_at ? now.getTime() - new Date(person.last_manual_add_at).getTime() : Infinity;
    // Randomized threshold per person per run, in the 14-21 day band, so the
    // trigger doesn't feel mechanical (doc's explicit wording). Deterministic
    // per-person-per-day would need a seeded RNG; a plain random pick is
    // simpler and the doc only asks that it not be a fixed day count, not
    // that it be reproducible.
    const thresholdDays = MANUAL_NUDGE_MIN_DAYS + Math.random() * (MANUAL_NUDGE_MAX_DAYS - MANUAL_NUDGE_MIN_DAYS);
    if (sinceLastAdd < thresholdDays * DAY_MS) continue;

    const alreadyNudgedRecently =
      person.last_manual_tier_nudge_sent_at &&
      now.getTime() - new Date(person.last_manual_tier_nudge_sent_at).getTime() < MANUAL_NUDGE_MIN_DAYS * DAY_MS;
    if (alreadyNudgedRecently) continue;

    const setting = await withServiceContext((trx) =>
      trx("notification_settings").where({ user_id: person.user_id, notification_type: "manual_tier_nudge" }).first()
    );
    // Opt-in only: unlike the general notification-worker default, a
    // MISSING settings row here means "not opted in," not "send anyway."
    if (!setting || setting.enabled !== true) continue;

    await notificationQueue.add("manual_tier_nudge", {
      recipientPersonId: person.id,
      type: "manual_tier_nudge",
      payload: {},
    });
    await withServiceContext((trx) => trx("persons").where({ id: person.id }).update({ last_manual_tier_nudge_sent_at: now }));
    notified++;
  }
  return { candidateCount: candidates.length, notified };
}

// docs/section2_pipeline.md section 4: due prompts by question_frequency.
// Question selection reuses the same simple "first unanswered bank
// question" logic as collection.routes.ts's GET /persons/:id/question-prompt
// — deliberately not the adaptive, Claude-personalized version described in
// the doc (needs a real Claude call, still a stub), and NOT the "adaptive
// frequency backs off below the user's ceiling" engagement-scoring behavior
// either — that needs a rolling prompts_sent/prompts_answered metric this
// schema doesn't track yet. Both are documented follow-ups, not silently
// dropped.
const FREQUENCY_INTERVAL_DAYS: Record<string, number> = { daily: 1, few_days: 3, weekly: 7 };

export async function sweepQuestionStreamPrompts(deps: ScheduledJobsDeps = defaultDeps) {
  const now = deps.now();
  const candidates = await withServiceContext((trx) =>
    trx("persons").where({ status: "active" }).whereNot({ question_frequency: "never" }).whereNotNull("question_frequency")
  );

  let notified = 0;
  for (const person of candidates) {
    const intervalDays = FREQUENCY_INTERVAL_DAYS[person.question_frequency];
    if (!intervalDays) continue;
    const due = !person.last_prompt_sent_at || now.getTime() - new Date(person.last_prompt_sent_at).getTime() >= intervalDays * DAY_MS;
    if (!due) continue;

    const question = await withServiceContext((trx) =>
      trx("interview_questions as q")
        .whereNotExists(
          trx("interview_answers as a")
            .join("interview_sessions as s", "s.id", "a.session_id")
            .whereRaw("a.question_id = q.id")
            .andWhere("s.person_id", person.id)
        )
        .orderBy("q.sort_order", "asc")
        .first()
    );
    if (!question) continue; // nothing left in the bank for this person right now

    await notificationQueue.add("question_prompt_ready", {
      recipientPersonId: person.id,
      type: "question_prompt_ready",
      payload: { questionId: question.id, questionText: question.text },
    });
    await withServiceContext((trx) => trx("persons").where({ id: person.id }).update({ last_prompt_sent_at: now }));
    notified++;
  }
  return { candidateCount: candidates.length, notified };
}

export async function runDailySweep(deps: ScheduledJobsDeps = defaultDeps) {
  const invitationResult = await sweepExpiredInvitations(deps);
  const subscriptionResult = await sweepSubscriptionLifecycle(deps);
  const reviewCardResult = await sweepReviewCardCadence(deps);
  const manualNudgeResult = await sweepManualTierNudges(deps);
  const questionStreamResult = await sweepQuestionStreamPrompts(deps);
  return {
    invitations: invitationResult,
    subscriptions: subscriptionResult,
    reviewCards: reviewCardResult,
    manualNudges: manualNudgeResult,
    questionStream: questionStreamResult,
  };
}

export const scheduledJobsWorker = new Worker("cron", async (_job: Job) => runDailySweep(), { connection });

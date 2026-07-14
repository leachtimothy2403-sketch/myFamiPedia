import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { db, withServiceContext } from "../db/pool";

export interface NotificationJobData {
  recipientPersonId: string;
  type: string;
  payload: Record<string, unknown>;
}

// Fully real, no external dependency — resolves the recipient's user
// account, honors their per-type notification_settings toggle (defaulting
// to "on" when no row exists yet, matching notification_settings' own
// column default), and writes the notifications row the API's
// GET /notifications route already reads. notifications/notification_settings
// have no RLS (see docs/data_model.md), so a plain `db` call is correct here
// — withServiceContext is used for the persons lookup since a worker has no
// per-request person/family context.
export async function processNotificationJob(data: NotificationJobData): Promise<void> {
  const { recipientPersonId, type, payload } = data;

  const person = await withServiceContext((trx) =>
    trx("persons").where({ id: recipientPersonId }).first("user_id")
  );
  // Pending/declined/opted-out people generally have no linked user account
  // yet — nothing to notify. Not an error, just a no-op.
  if (!person?.user_id) return;

  const setting = await db("notification_settings")
    .where({ user_id: person.user_id, notification_type: type })
    .first();
  if (setting && setting.enabled === false) return;

  await db("notifications").insert({ user_id: person.user_id, type, payload: JSON.stringify(payload) });
}

export const notificationWorker = new Worker(
  "notification",
  async (job: Job<NotificationJobData>) => processNotificationJob(job.data),
  { connection }
);

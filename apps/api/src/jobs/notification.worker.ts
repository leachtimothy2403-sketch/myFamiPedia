import { Worker } from "bullmq";
import { connection } from "./queue";
// Dispatches to push (Expo) and/or email per docs/api_structure.md's Notifications
// table — checks notification_settings before sending, coalesces same-day/same-type
// notifications per docs/section2_pipeline.md section 5.
export const notificationWorker = new Worker(
  "notification",
  async (_job) => {
    throw new Error("Not implemented — see docs/section2_pipeline.md");
  },
  { connection }
);

// Separate PM2 process (see ecosystem.config.js) — keeps worker crashes from
// taking down the API process and vice versa.
import "./faceDetection.worker";
import "./holdingSpaceDrain.worker";
import "./transcription.worker";
import "./voiceCloning.worker";
import "./embedding.worker";
import "./notification.worker";
import "./scheduledJobs.worker";
import "./sceneClassification.worker";
import "./sceneClassificationReview.worker";
import "./photoClustering.worker";
import "./memoryBiography.worker";
import { cronQueue } from "./queue";

// Schedules the Q_CRON daily sweep (docs/invitation_flow.md, docs/section2_pipeline.md)
// as a BullMQ repeatable job rather than pulling in a separate cron library —
// adding a job with the same jobId + repeat pattern is idempotent (BullMQ
// replaces the existing scheduler rather than duplicating it), so it's safe
// to call this on every worker-process boot. 03:00 is an arbitrary
// low-traffic slot; adjust to the family base's actual timezone spread once
// there's real usage data.
cronQueue.add(
  "daily-sweep",
  {},
  { repeat: { pattern: "0 3 * * *" }, jobId: "daily-sweep" }
);

// eslint-disable-next-line no-console
console.log("myFamiPedia workers started");

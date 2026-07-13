import { Worker } from "bullmq";
import { connection } from "./queue";
// See docs/media_pipeline.md, section 2 — face collection scope is the core
// privacy control. Only status='active' persons are ever enrolled.
export const faceDetectionWorker = new Worker(
  "face-detection",
  async (_job) => {
    throw new Error("Not implemented — see docs/media_pipeline.md");
  },
  { connection }
);

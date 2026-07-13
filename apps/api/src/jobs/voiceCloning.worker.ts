import { Worker } from "bullmq";
import { connection } from "./queue";
// See docs/voice_pipeline.md section 2 — the four-moment consent flow's
// threshold-triggered actions (preview / decision prompt / professional upgrade)
// run from here as accumulated audio crosses each threshold.
export const voiceCloningWorker = new Worker(
  "voice-cloning",
  async (_job) => {
    throw new Error("Not implemented — see docs/voice_pipeline.md");
  },
  { connection }
);

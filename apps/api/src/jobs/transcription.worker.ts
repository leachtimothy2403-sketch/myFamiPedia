import { Worker } from "bullmq";
import { connection } from "./queue";
// See docs/voice_pipeline.md section 1 + the mid-conversation photo note —
// this worker also promotes interview_answer_photos into memory_photos
// once the memory row exists.
export const transcriptionWorker = new Worker(
  "transcription",
  async (_job) => {
    throw new Error("Not implemented — see docs/voice_pipeline.md");
  },
  { connection }
);

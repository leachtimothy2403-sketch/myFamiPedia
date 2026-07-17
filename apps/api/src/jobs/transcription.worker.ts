import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { processTranscribeJob, TranscribeJobData } from "./transcribeAnswer";

// The reusable logic (DB reads, Whisper/Scribe call, memory creation) lives
// in transcribeAnswer.ts — this file's only job is wiring it to the queue.
// Kept separate specifically so interviews.routes.ts can call
// processTranscribeJob directly (for immediate, in-session transcription)
// without importing this file and accidentally spinning up a second Worker
// inside the API process — see that file's docstring.
export const transcriptionWorker = new Worker(
  "transcription",
  async (job: Job<TranscribeJobData>) => processTranscribeJob(job.data),
  { connection }
);

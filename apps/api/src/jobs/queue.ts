import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

export const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

// One queue per job family from docs/system_architecture.mermaid's "Background Workers" box.
export const faceDetectionQueue = new Queue("face-detection", { connection });
export const transcriptionQueue = new Queue("transcription", { connection });
export const voiceCloningQueue = new Queue("voice-cloning", { connection });
export const embeddingQueue = new Queue("embedding", { connection });
export const notificationQueue = new Queue("notification", { connection });
// Processes everything accumulated in holding_space for a person all at once
// once they accept an invitation — see docs/invitation_flow.md "Accept" step 3
// and docs/media_pipeline.md section 3.
export const holdingSpaceQueue = new Queue("holding-space-drain", { connection });

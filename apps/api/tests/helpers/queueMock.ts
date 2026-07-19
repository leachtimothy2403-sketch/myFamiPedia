import { vi } from "vitest";

/**
 * There's no Redis available in this test environment, and BullMQ's Queue
 * relies on real Redis-side Lua scripts internally — a generic ioredis mock
 * wouldn't reliably emulate that. Since what we actually want to verify is
 * "did the route enqueue the right job with the right payload" (the actual
 * job processing is a separate, still-stubbed worker concern), each queue is
 * replaced with a fake exposing a spy-able `add`.
 *
 * Call `mockQueues()` at the top of a test file (before any dynamic import of
 * application code) to install this; use `getQueueMock("notificationQueue")`
 * from within a test to assert on calls.
 */
const fakeQueues: Record<string, { add: ReturnType<typeof vi.fn> }> = {};

function fakeQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

export function mockQueues() {
  vi.mock("../../src/jobs/queue", () => {
    fakeQueues.faceDetectionQueue = fakeQueue();
    fakeQueues.transcriptionQueue = fakeQueue();
    fakeQueues.voiceCloningQueue = fakeQueue();
    fakeQueues.embeddingQueue = fakeQueue();
    fakeQueues.notificationQueue = fakeQueue();
    fakeQueues.holdingSpaceQueue = fakeQueue();
    fakeQueues.cronQueue = fakeQueue();
    // docs/photo_pipeline_beta_architecture.md sections 5-6 — stage 1/2
    // scene classification + batch clustering, enqueued from
    // collection.routes.ts alongside the queues above.
    fakeQueues.sceneClassificationQueue = fakeQueue();
    fakeQueues.sceneClassificationReviewQueue = fakeQueue();
    fakeQueues.photoClusteringQueue = fakeQueue();
    // memories.routes.ts, 2026-07-20 — folds share-a-memory/photo-caption
    // content into the running biography (memoryBiography.worker.ts).
    fakeQueues.memoryBiographyQueue = fakeQueue();
    return { ...fakeQueues, connection: {} };
  });
}

export function getQueueMock(name: keyof typeof fakeQueues) {
  return fakeQueues[name];
}

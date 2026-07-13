import { Worker } from "bullmq";
import { connection } from "./queue";
// See docs/search.md — text mode for memories, image mode for photos,
// both voyage-multimodal-3.5, both land in the same 1024-dim vector space.
export const embeddingWorker = new Worker(
  "embedding",
  async (_job) => {
    throw new Error("Not implemented — see docs/search.md");
  },
  { connection }
);

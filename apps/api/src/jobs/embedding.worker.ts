import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { embeddingService as defaultEmbeddingService, EmbeddingService } from "../services/embeddings.service";

export interface EmbedMemoryJobData {
  memoryId: string;
}
export interface EmbedPhotoJobData {
  photoId: string;
}

export interface EmbeddingDeps {
  embeddings: EmbeddingService;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: EmbeddingDeps = { embeddings: defaultEmbeddingService, getBytes: getObjectBuffer };

// pgvector accepts a bracketed literal ('[0.1,0.2,...]') cast to vector —
// there's no native JS<->vector binding in node-postgres, so this is the
// standard way to write one via a parameterized query.
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function guessMimeType(r2Key: string): string {
  const ext = r2Key.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}

// docs/search.md's Q_EMBED worker, two triggers: memories insert/update
// (text mode) and photos upload complete (image mode). Both write into the
// same 1024-dim voyage-multimodal-3.5 space so the semantic search union
// query (search.routes.ts) can rank memory and photo hits together.
export async function processEmbedMemoryJob(data: EmbedMemoryJobData, deps: EmbeddingDeps = defaultDeps) {
  const { memoryId } = data;
  const memory = await withServiceContext((trx) => trx("memories").where({ id: memoryId }).first());
  if (!memory) throw new Error(`Memory ${memoryId} not found`);

  // Nothing text-shaped to embed (e.g. a bare photo-provenance memory with
  // no caption) — not an error, just nothing to do here.
  if (!memory.content) return { memoryId, skipped: true as const };

  const [embedding] = await deps.embeddings.embedText([memory.content]);
  await withServiceContext((trx) =>
    trx("memories")
      .where({ id: memoryId })
      .update({ embedding: trx.raw("?::vector", [toVectorLiteral(embedding)]) })
  );
  return { memoryId, skipped: false as const };
}

export async function processEmbedPhotoJob(data: EmbedPhotoJobData, deps: EmbeddingDeps = defaultDeps) {
  const { photoId } = data;
  const photo = await withServiceContext((trx) => trx("photos").where({ id: photoId }).first());
  if (!photo) throw new Error(`Photo ${photoId} not found`);

  const bytes = await deps.getBytes(photo.r2_key);
  const [embedding] = await deps.embeddings.embedImage([{ bytes, mimeType: guessMimeType(photo.r2_key) }]);
  await withServiceContext((trx) =>
    trx("photos")
      .where({ id: photoId })
      .update({ embedding: trx.raw("?::vector", [toVectorLiteral(embedding)]) })
  );
  return { photoId };
}

export const embeddingWorker = new Worker(
  "embedding",
  async (job: Job) => {
    if (job.name === "embed-memory") return processEmbedMemoryJob(job.data as EmbedMemoryJobData);
    if (job.name === "embed-photo") return processEmbedPhotoJob(job.data as EmbedPhotoJobData);
    throw new Error(`Unknown embedding job name: ${job.name}`);
  },
  { connection }
);

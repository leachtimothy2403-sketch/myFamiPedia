import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { classifyMemoryCategory } from "../services/claude.service";
import { recordMemoryInBiography } from "../services/biography.service";

export interface UpdateBiographyFromMemoryJobData {
  memoryId: string;
}

export interface MemoryBiographyDeps {
  classify: (content: string) => Promise<string | null>;
  record: (params: { personId: string; personName: string; lifePhase: string; content: string; memoryId: string }) => Promise<void>;
}

const defaultDeps: MemoryBiographyDeps = {
  classify: classifyMemoryCategory,
  record: (params) => withServiceContext((trx) => recordMemoryInBiography(trx, params)),
};

// 2026-07-20 — the other half of extending the running biography
// (docs/handover_2026-07-19-qa-persona-eval.md's fifth-order fix) beyond the
// Q&A interview flow: memories.routes.ts enqueues this whenever a memory's
// content becomes non-empty, whether that's a direct share (POST /memories)
// or a caption added later to a photo-sourced memory (PATCH /memories/:id —
// photo-accepted memories start with content: null, see that route's own
// comment on the gap it closed). Deliberately its own worker rather than
// inline in the route: classification + the biography-summary rewrite are
// both real Claude calls, and this shouldn't add that latency to the
// user-facing request the way it would if awaited synchronously in the
// route handler — same reasoning that already justified embeddingQueue for
// memory embedding.
export async function processUpdateBiographyFromMemoryJob(
  data: UpdateBiographyFromMemoryJobData,
  deps: MemoryBiographyDeps = defaultDeps
) {
  const { memoryId } = data;

  const memory = await withServiceContext((trx) => trx("memories").where({ id: memoryId }).first());
  if (!memory) throw new Error(`Memory ${memoryId} not found`);

  // Nothing to categorize yet (a bare photo-provenance memory with no
  // caption) — not an error, this job just gets enqueued again once/if a
  // caption is added later via PATCH /memories/:id.
  if (!memory.content) return { memoryId, skipped: "no-content" as const };

  // Private memories never fold into the shared, family-facing biography /
  // persons.ai_summary (GET /persons/:id/summary) — unlike interview
  // answers, which have no privacy flag at all, `memories` deliberately
  // does, and the whole point of is_private is that the contributor chose
  // to restrict who sees it. Folding it into an aggregate "who they were"
  // document anyone in the family can read would quietly defeat that choice.
  if (memory.is_private) return { memoryId, skipped: "private" as const };

  // A retraction that lands between this job being enqueued and processed
  // (rare, but possible) — skip rather than fold in something the
  // contributor just took back.
  if (memory.retracted) return { memoryId, skipped: "retracted" as const };

  const lifePhase = await deps.classify(memory.content);
  // Too short/vague to place in one specific category (classifyMemoryCategory's
  // NONE case) — not every freeform memory reads as belonging to one of the
  // eighteen life-story categories, and mis-filing a bare caption into one
  // would pollute that category's summary with something that doesn't
  // actually inform it.
  if (!lifePhase) return { memoryId, skipped: "unclassifiable" as const };

  // Whoever the memory is actually ABOUT, not necessarily whoever wrote it —
  // a grandchild sharing a memory about grandma should inform grandma's
  // biography, not the grandchild's. Falls back to the contributor only when
  // nobody else is tagged (a memory about the contributor's own life, or one
  // where tagging was skipped). memory_persons only ever holds ACTIVE tags
  // (still-pending tags are held in holding_space until accepted — see
  // memories.routes.ts's POST /memories) — a still-pending tag correctly
  // doesn't inform anyone's biography yet either.
  const taggedPersons: { person_id: string }[] = await withServiceContext((trx) =>
    trx("memory_persons").where({ memory_id: memoryId }).select("person_id")
  );
  const targetPersonIds = taggedPersons.length ? taggedPersons.map((t) => t.person_id) : [memory.contributor_id];

  const targetPersons: { id: string; name: string }[] = await withServiceContext((trx) =>
    trx("persons").whereIn("id", targetPersonIds).select("id", "name")
  );

  for (const person of targetPersons) {
    await deps.record({ personId: person.id, personName: person.name, lifePhase, content: memory.content, memoryId });
  }

  return { memoryId, lifePhase, filedUnder: targetPersons.map((p) => p.id) };
}

export const memoryBiographyWorker = new Worker(
  "memory-biography",
  async (job: Job) => {
    if (job.name === "update-biography") return processUpdateBiographyFromMemoryJob(job.data as UpdateBiographyFromMemoryJobData);
    throw new Error(`Unknown memory-biography job name: ${job.name}`);
  },
  { connection }
);

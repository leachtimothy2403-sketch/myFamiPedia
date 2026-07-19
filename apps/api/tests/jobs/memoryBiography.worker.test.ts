import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";
import type { MemoryBiographyDeps } from "../../src/jobs/memoryBiography.worker";

mockQueues();

describe("memory-biography worker", () => {
  const ctx = withDb();

  async function seedFamily() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [contributor] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Grandchild", status: "active" })
      .returning("*");
    return { group, contributor };
  }

  async function seedMemory(groupId: string, contributorId: string, overrides: Partial<Record<string, unknown>> = {}) {
    const [memory] = await ctx
      .knex()("memories")
      .insert({
        family_group_id: groupId,
        contributor_id: contributorId,
        content: "I found a stray cat behind the rail yard and named him Rusty.",
        provenance_type: "text",
        ...overrides,
      })
      .returning("*");
    return memory;
  }

  it("classifies the memory and records it under the contributor when nobody else is tagged", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const { group, contributor } = await seedFamily();
    const memory = await seedMemory(group.id, contributor.id);

    const classify = vi.fn(async () => "childhood");
    const record = vi.fn(async () => {});
    const deps: MemoryBiographyDeps = { classify, record };

    const result = await processUpdateBiographyFromMemoryJob({ memoryId: memory.id }, deps);

    expect(classify).toHaveBeenCalledWith(memory.content);
    expect(record).toHaveBeenCalledWith({
      personId: contributor.id,
      personName: contributor.name,
      lifePhase: "childhood",
      content: memory.content,
    });
    expect(result).toMatchObject({ memoryId: memory.id, lifePhase: "childhood", filedUnder: [contributor.id] });
  });

  // A grandchild sharing a memory about grandma should inform grandma's
  // biography, not the grandchild's who happened to type it in.
  it("records it under the tagged person(s) instead of the contributor when the memory is tagged", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const { group, contributor } = await seedFamily();
    const [grandma] = await ctx
      .knex()("persons")
      .insert({ family_group_id: group.id, name: "Grandma", status: "active" })
      .returning("*");
    const memory = await seedMemory(group.id, contributor.id, {
      content: "Grandma used to sing in the church choir every Sunday.",
    });
    await ctx.knex()("memory_persons").insert({ memory_id: memory.id, person_id: grandma.id });

    const classify = vi.fn(async () => "community_faith");
    const record = vi.fn(async () => {});
    const result = await processUpdateBiographyFromMemoryJob({ memoryId: memory.id }, { classify, record });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      personId: grandma.id,
      personName: "Grandma",
      lifePhase: "community_faith",
      content: memory.content,
    });
    expect(result.filedUnder).toEqual([grandma.id]);
  });

  it("files under every tagged person when more than one is tagged", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const { group, contributor } = await seedFamily();
    const [personA] = await ctx.knex()("persons").insert({ family_group_id: group.id, name: "A", status: "active" }).returning("*");
    const [personB] = await ctx.knex()("persons").insert({ family_group_id: group.id, name: "B", status: "active" }).returning("*");
    const memory = await seedMemory(group.id, contributor.id, { content: "The two of them threw the best anniversary party." });
    await ctx.knex()("memory_persons").insert([
      { memory_id: memory.id, person_id: personA.id },
      { memory_id: memory.id, person_id: personB.id },
    ]);

    const classify = vi.fn(async () => "turning_points");
    const record = vi.fn(async () => {});
    const result = await processUpdateBiographyFromMemoryJob({ memoryId: memory.id }, { classify, record });

    expect(record).toHaveBeenCalledTimes(2);
    expect(result.filedUnder?.sort()).toEqual([personA.id, personB.id].sort());
  });

  it("skips a memory with no content yet, without classifying", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const { group, contributor } = await seedFamily();
    const memory = await seedMemory(group.id, contributor.id, { content: null, provenance_type: "photo" });

    const classify = vi.fn();
    const record = vi.fn();
    const result = await processUpdateBiographyFromMemoryJob({ memoryId: memory.id }, { classify, record });

    expect(result).toEqual({ memoryId: memory.id, skipped: "no-content" });
    expect(classify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  // The one privacy-relevant behavior this whole feature depends on getting
  // right: is_private has no equivalent at all on interview_answers, so this
  // is new territory the Q&A path never had to guard against.
  it("skips a private memory rather than folding it into the shared biography", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const { group, contributor } = await seedFamily();
    const memory = await seedMemory(group.id, contributor.id, { is_private: true });

    const classify = vi.fn();
    const record = vi.fn();
    const result = await processUpdateBiographyFromMemoryJob({ memoryId: memory.id }, { classify, record });

    expect(result).toEqual({ memoryId: memory.id, skipped: "private" });
    expect(classify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("skips a retracted memory", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const { group, contributor } = await seedFamily();
    const memory = await seedMemory(group.id, contributor.id, { retracted: true, retracted_at: new Date() });

    const classify = vi.fn();
    const record = vi.fn();
    const result = await processUpdateBiographyFromMemoryJob({ memoryId: memory.id }, { classify, record });

    expect(result).toEqual({ memoryId: memory.id, skipped: "retracted" });
    expect(classify).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("skips a memory too vague to classify (classify returns null), without recording anything", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const { group, contributor } = await seedFamily();
    const memory = await seedMemory(group.id, contributor.id, { content: "Beach day!" });

    const classify = vi.fn(async () => null);
    const record = vi.fn();
    const result = await processUpdateBiographyFromMemoryJob({ memoryId: memory.id }, { classify, record });

    expect(result).toEqual({ memoryId: memory.id, skipped: "unclassifiable" });
    expect(record).not.toHaveBeenCalled();
  });

  it("throws a clear error for an unknown memory id", async () => {
    const { processUpdateBiographyFromMemoryJob } = await import("../../src/jobs/memoryBiography.worker");
    const classify = vi.fn();
    const record = vi.fn();
    await expect(
      processUpdateBiographyFromMemoryJob({ memoryId: "00000000-0000-0000-0000-000000000000" }, { classify, record })
    ).rejects.toThrow(/not found/);
  });
});

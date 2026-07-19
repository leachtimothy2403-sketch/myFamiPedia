import { describe, it, expect, vi, afterEach } from "vitest";
import { withDb } from "../helpers/withDb";

// recordAnswerInBiography calls claude.service.ts's updateBiographySectionSummary,
// a real Anthropic API call — stubbed the same way claude.service.test.ts
// does, so this stays deterministic and offline regardless of whether a real
// ANTHROPIC_API_KEY happens to be set locally (it often is — see
// docs/handover_2026-07-19-qa-persona-eval.md on the pre-existing test
// failures that exact situation caused elsewhere in this suite).
//
// 2026-07-20 fix — this file used to mutate process.env.ANTHROPIC_API_KEY
// directly in beforeEach/afterEach. That does nothing: config/env.ts reads
// process.env once, at module-import time, into a plain `env` object that
// every other module (including claude.service.ts) imports and reads from —
// never process.env directly. By the time this file's beforeEach runs, `env`
// is already built and frozen. Locally this was invisible because Tim's real
// .env has a working key, so env.anthropicApiKey was already truthy before
// any test ran — the beforeEach mutation looked like it was doing something
// but never needed to. CI has no .env and no ANTHROPIC_API_KEY secret for
// this job, which is what actually exposed it: env.anthropicApiKey was
// genuinely empty and stayed that way, so every recordAnswerInBiography call
// hit the same "not configured" error claude.service.test.ts already guards
// against with a direct vi.mock of config/env — mirrored here with one
// difference: this file (unlike claude.service.test.ts) also needs a real DB
// connection through withDb(), and src/db/knexfile.ts reads env.databaseUrl
// from this exact same module. A bare vi.mock returning only
// { anthropicApiKey } would blow away databaseUrl/nodeEnv/everything else
// and break the DB connection for the whole file. importOriginal() keeps the
// real env (built after createTestDb() has already pointed DATABASE_URL at
// the throwaway pglite instance, since nothing here imports config/env until
// withDb()'s beforeAll dynamically imports db/pool.ts) and overrides only
// anthropicApiKey.
vi.mock("../../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env")>();
  return { env: { ...actual.env, anthropicApiKey: "test-key" } };
});

describe("biography.service", () => {
  const ctx = withDb();

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "test-key";
  });

  function mockClaudeSummary(text: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) }))
    );
  }

  async function createPerson() {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [person] = await knex("persons").insert({ family_group_id: group.id, name: "Peggy", status: "active" }).returning("*");
    return person;
  }

  it("creates a new section on the first answer in a category", async () => {
    const { recordAnswerInBiography, getBiographySections } = await import("../../src/services/biography.service");
    const person = await createPerson();
    mockClaudeSummary("Grew up two streets from the rail yard.");

    await recordAnswerInBiography(ctx.knex(), {
      personId: person.id,
      personName: person.name,
      lifePhase: "childhood",
      question: "What was your street like?",
      answer: "We lived two streets from the rail yard.",
    });

    const sections = await getBiographySections(ctx.knex(), person.id);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toEqual({
      lifePhase: "childhood",
      summary: "Grew up two streets from the rail yard.",
      askedQuestionStems: ["What was your street like?"],
      questionCount: 1,
    });
  });

  it("merges a second answer in the same category into the existing row rather than creating a new one", async () => {
    const { recordAnswerInBiography, getBiographySections } = await import("../../src/services/biography.service");
    const person = await createPerson();

    mockClaudeSummary("Grew up two streets from the rail yard.");
    await recordAnswerInBiography(ctx.knex(), {
      personId: person.id,
      personName: person.name,
      lifePhase: "childhood",
      question: "What was your street like?",
      answer: "We lived two streets from the rail yard.",
    });

    mockClaudeSummary("Grew up two streets from the rail yard and rescued a stray cat named Rusty at nine.");
    await recordAnswerInBiography(ctx.knex(), {
      personId: person.id,
      personName: person.name,
      lifePhase: "childhood",
      question: "Did you ever have a pet growing up?",
      answer: "Yes, a stray cat I named Rusty.",
    });

    const sections = await getBiographySections(ctx.knex(), person.id);
    expect(sections).toHaveLength(1); // still one row, not two
    expect(sections[0].summary).toBe("Grew up two streets from the rail yard and rescued a stray cat named Rusty at nine.");
    expect(sections[0].askedQuestionStems).toEqual(["What was your street like?", "Did you ever have a pet growing up?"]);
    expect(sections[0].questionCount).toBe(2);
  });

  it("keeps separate categories as separate rows", async () => {
    const { recordAnswerInBiography, getBiographySections } = await import("../../src/services/biography.service");
    const person = await createPerson();

    mockClaudeSummary("Grew up two streets from the rail yard.");
    await recordAnswerInBiography(ctx.knex(), {
      personId: person.id,
      personName: person.name,
      lifePhase: "childhood",
      question: "What was your street like?",
      answer: "We lived two streets from the rail yard.",
    });

    mockClaudeSummary("Worked at Kessler's Department Store as a teenager.");
    await recordAnswerInBiography(ctx.knex(), {
      personId: person.id,
      personName: person.name,
      lifePhase: "work",
      question: "What was your first job?",
      answer: "Kessler's Department Store.",
    });

    const sections = await getBiographySections(ctx.knex(), person.id);
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.lifePhase).sort()).toEqual(["childhood", "work"]);
  });

  it("passes the existing summary and new Q&A through to the Claude call", async () => {
    const { recordAnswerInBiography } = await import("../../src/services/biography.service");
    const person = await createPerson();

    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "Updated summary." }] }) };
      })
    );

    await recordAnswerInBiography(ctx.knex(), {
      personId: person.id,
      personName: person.name,
      lifePhase: "childhood",
      question: "What was your street like?",
      answer: "We lived two streets from the rail yard.",
    });

    expect(capturedPrompt).toContain("Peggy");
    expect(capturedPrompt).toContain("childhood");
    expect(capturedPrompt).toContain("What was your street like?");
    expect(capturedPrompt).toContain("We lived two streets from the rail yard.");
  });

  it("getBiographySections returns an empty array for a person with no answered questions yet", async () => {
    const { getBiographySections } = await import("../../src/services/biography.service");
    const person = await createPerson();
    const sections = await getBiographySections(ctx.knex(), person.id);
    expect(sections).toEqual([]);
  });

  // recordMemoryInBiography — the memoryBiography.worker.ts entry point for
  // content that reaches the biography from outside the Q&A flow (a memory
  // shared directly, or a caption added to a photo-sourced memory).
  describe("recordMemoryInBiography", () => {
    it("creates a section from a memory the same way an interview answer would", async () => {
      const { recordMemoryInBiography, getBiographySections } = await import("../../src/services/biography.service");
      const person = await createPerson();
      mockClaudeSummary("Rescued a stray cat named Rusty at nine.");

      await recordMemoryInBiography(ctx.knex(), {
        personId: person.id,
        personName: person.name,
        lifePhase: "childhood",
        content: "I found a stray cat behind the rail yard and named him Rusty.",
      });

      const sections = await getBiographySections(ctx.knex(), person.id);
      expect(sections).toHaveLength(1);
      expect(sections[0].lifePhase).toBe("childhood");
      expect(sections[0].summary).toBe("Rescued a stray cat named Rusty at nine.");
      expect(sections[0].questionCount).toBe(1);
    });

    it("merges into the same row a Q&A answer already created in that category", async () => {
      const { recordAnswerInBiography, recordMemoryInBiography, getBiographySections } = await import(
        "../../src/services/biography.service"
      );
      const person = await createPerson();

      mockClaudeSummary("Grew up two streets from the rail yard.");
      await recordAnswerInBiography(ctx.knex(), {
        personId: person.id,
        personName: person.name,
        lifePhase: "childhood",
        question: "What was your street like?",
        answer: "We lived two streets from the rail yard.",
      });

      mockClaudeSummary("Grew up two streets from the rail yard and rescued a stray cat named Rusty at nine.");
      await recordMemoryInBiography(ctx.knex(), {
        personId: person.id,
        personName: person.name,
        lifePhase: "childhood",
        content: "I found a stray cat behind the rail yard and named him Rusty.",
      });

      const sections = await getBiographySections(ctx.knex(), person.id);
      expect(sections).toHaveLength(1); // one row, not two
      expect(sections[0].questionCount).toBe(2);
      expect(sections[0].askedQuestionStems).toHaveLength(2);
    });

    // The whole reason this doesn't just pass a fixed placeholder through as
    // the "question" — tallyCategoryCounts (claude.service.ts) reads
    // askedQuestionStems.length as the whole-interview category tally, and
    // recordAnswerInBiography dedupes identical stems. A repeated fixed
    // placeholder would silently stop incrementing that tally after the
    // first memory in a category.
    it("gives each memory a distinct stem so repeated memories in one category don't collapse into a single stem", async () => {
      const { recordMemoryInBiography, getBiographySections } = await import("../../src/services/biography.service");
      const person = await createPerson();

      mockClaudeSummary("Summary after first memory.");
      await recordMemoryInBiography(ctx.knex(), {
        personId: person.id,
        personName: person.name,
        lifePhase: "work",
        content: "My first job was at Kessler's Department Store.",
      });

      mockClaudeSummary("Summary after second memory.");
      await recordMemoryInBiography(ctx.knex(), {
        personId: person.id,
        personName: person.name,
        lifePhase: "work",
        content: "I got promoted to floor manager after two years there.",
      });

      const sections = await getBiographySections(ctx.knex(), person.id);
      expect(sections).toHaveLength(1);
      expect(sections[0].askedQuestionStems).toHaveLength(2);
      expect(sections[0].askedQuestionStems[0]).not.toBe(sections[0].askedQuestionStems[1]);
    });

    it("passes the memory content through to the Claude call as the answer, with a synthesized stem as the question", async () => {
      const { recordMemoryInBiography } = await import("../../src/services/biography.service");
      const person = await createPerson();

      let capturedPrompt = "";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
          capturedPrompt = JSON.parse(init.body).messages[0].content as string;
          return { ok: true, json: async () => ({ content: [{ type: "text", text: "Updated summary." }] }) };
        })
      );

      await recordMemoryInBiography(ctx.knex(), {
        personId: person.id,
        personName: person.name,
        lifePhase: "work",
        content: "My first job was at Kessler's Department Store.",
      });

      expect(capturedPrompt).toContain("My first job was at Kessler's Department Store.");
      expect(capturedPrompt).toContain("memory shared");
    });
  });
});

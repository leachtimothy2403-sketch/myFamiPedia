import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withDb } from "../helpers/withDb";

// recordAnswerInBiography calls claude.service.ts's updateBiographySectionSummary,
// a real Anthropic API call — stubbed the same way claude.service.test.ts
// does, so this stays deterministic and offline regardless of whether a real
// ANTHROPIC_API_KEY happens to be set locally (it often is — see
// docs/handover_2026-07-19-qa-persona-eval.md on the pre-existing test
// failures that exact situation caused elsewhere in this suite).
describe("biography.service", () => {
  const ctx = withDb();
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
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
});

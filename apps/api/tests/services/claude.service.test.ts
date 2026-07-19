import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pure unit tests — no DB needed. config/env.ts's other vars all have safe
// defaults (see its docstring), and dotenv.config() never overwrites an
// already-set process.env var, so setting/unsetting ANTHROPIC_API_KEY here
// before each dynamic import is enough to exercise both branches cleanly.
describe("claude.service — generateFollowUpQuestion", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  function mockClaudeResponse(text: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) }))
    );
  }

  it("throws a clear, catchable error when ANTHROPIC_API_KEY is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    await expect(
      generateFollowUpQuestion({ personName: "Peggy", priorQAs: [], priorQuestionTexts: [], recentCategories: [] })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  // 2026-07-19 fix — the persona eval (docs/handover_2026-07-19-qa-persona-eval.md)
  // found real follow-up repeats on a long (40-question) interview. Root
  // cause: the prompt's "don't repeat a question already asked" instruction
  // only ever had visibility into whichever answers were in priorQAs, which
  // interviews.routes.ts caps at the most recent 8 for cost reasons — so
  // anything asked earlier than that (including from the curated bank
  // itself) was invisible to the model. priorQuestionTexts is the fix: the
  // full history of question text (no answers, so it stays cheap), passed
  // in full regardless of interview length. This test is the regression
  // guard — it fails if a future change goes back to only using priorQAs
  // for de-duplication.
  it("includes every previously asked question in the prompt, not just the ones with detailed recent answers", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "CATEGORY: passions\nQUESTION: What is a place that always feels like home to you?" }],
          }),
        };
      })
    );

    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");

    // 10 questions asked in total, but only the 3 most recent carry detailed
    // answer-level context — mirrors interviews.routes.ts's real shape once
    // an interview runs past its priorAnswers cap.
    const allTexts = Array.from({ length: 10 }, (_, i) => ({
      question: `Question number ${i + 1}, spelled out so it can't collide with anything else?`,
      lifePhase: "childhood",
    }));
    const recentQAs = allTexts.slice(-3).map((q) => ({ question: q.question, answer: `Answer to: ${q.question}`, lifePhase: q.lifePhase }));

    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: recentQAs,
      priorQuestionTexts: allTexts,
      recentCategories: [],
    });

    expect(result).toEqual({ question: "What is a place that always feels like home to you?", lifePhase: "passions" });
    for (const q of allTexts) {
      expect(capturedPrompt).toContain(q.question);
    }
    expect(capturedPrompt.toLowerCase()).toContain("do not ask anything substantively the same");
  });

  // 2026-07-19 — category spread. Tim's direction after reviewing eval
  // output: don't let follow-ups camp on one of the eighteen categories for
  // more than a couple of questions in a row. This checks the instruction
  // and the recent-category sequence both actually reach the prompt, and
  // that a well-formed CATEGORY/QUESTION response is parsed correctly.
  it("includes the recent category sequence and the anti-fixation rule in the prompt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "CATEGORY: friendship\nQUESTION: What did Sunday mornings look like in your house?" }] }),
        };
      })
    );
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");

    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: [],
      priorQuestionTexts: [],
      recentCategories: ["partnership", "partnership", "partnership"],
    });

    expect(result).toEqual({ question: "What did Sunday mornings look like in your house?", lifePhase: "friendship" });
    expect(capturedPrompt).toContain("partnership -> partnership -> partnership");
    expect(capturedPrompt.toLowerCase()).toContain("three or more of the most recent questions in a row");
  });

  // If Claude's response doesn't parse into one of the eighteen known
  // categories (malformed CATEGORY line, or a hallucinated one), fall back
  // deterministically instead of silently storing garbage in life_phase —
  // and the fallback should still serve the "spread across categories"
  // goal, not just default to some fixed category every time.
  it("falls back to the least-recently-used known category when the response doesn't name a valid one", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "QUESTION: What do you remember most fondly about your grandparents?" }] }),
      }))
    );
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");

    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: [],
      priorQuestionTexts: [],
      recentCategories: ["childhood", "childhood"],
    });

    expect(result.question).toBe("What do you remember most fondly about your grandparents?");
    // "childhood" has been used twice, everything else zero times — the
    // fallback should pick one of the untouched categories, not childhood.
    expect(result.lifePhase).not.toBe("childhood");
  });

  it("strips surrounding quotes from the question text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockClaudeResponse('CATEGORY: legacy\nQUESTION: "What did Sunday mornings look like in your house?"');
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    const result = await generateFollowUpQuestion({ personName: "Peggy", priorQAs: [], priorQuestionTexts: [], recentCategories: [] });
    expect(result).toEqual({ question: "What did Sunday mornings look like in your house?", lifePhase: "legacy" });
  });

  it("surfaces a clear error when the Claude request fails on every retry attempt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => "internal error" }));
    vi.stubGlobal("fetch", fetchMock);
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    await expect(
      generateFollowUpQuestion({ personName: "Peggy", priorQAs: [], priorQuestionTexts: [], recentCategories: [] })
    ).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // exhausted all retry attempts
  });

  // 2026-07-19 fix — a real interview hit exactly this ("no follow-up
  // question text") mid-run and took the whole GET /interview-questions/next
  // request down with it (docs/handover_2026-07-19-qa-persona-eval.md).
  // Regression guard: a transient bad response followed by a good one
  // should recover transparently rather than fail the whole request.
  it("recovers from a transient empty response by retrying", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount < 3) {
          // Empty content — the real failure mode, not an HTTP error.
          return { ok: true, json: async () => ({ content: [], stop_reason: "end_turn" }) };
        }
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "CATEGORY: values\nQUESTION: What does resilience mean to you?" }] }),
        };
      })
    );
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: [],
      priorQuestionTexts: [],
      recentCategories: [],
    });
    expect(result).toEqual({ question: "What does resilience mean to you?", lifePhase: "values" });
    expect(callCount).toBe(3);
  });
});

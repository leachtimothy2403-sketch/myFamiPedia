import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 2026-07-19 fifth fix, same day — the "not configured" tests below used to
// delete process.env.ANTHROPIC_API_KEY and rely on vi.resetModules() forcing
// a fresh re-import of config/env.ts to pick that up. That silently breaks
// whenever a real ANTHROPIC_API_KEY is set in the repo root .env (Tim's own
// local setup, and probably any real dev environment): env.ts's
// dotenv.config() only skips a var that's already set, so once the test
// deletes it, the fresh re-import's dotenv.config() call happily reloads the
// real key from .env right back into process.env — the delete never
// actually sticks. This was already one of the pre-existing failures flagged
// in docs/handover_2026-07-19-qa-persona-eval.md before this session even
// started; adding two more tests with the same pattern (below, for the new
// biography functions) rather than fixing it would've just made three.
// Mocking config/env.ts directly sidesteps the .env file entirely, giving
// every test in this file a mocked { anthropicApiKey: "test-key" } object
// regardless of what's actually in .env. The one test per describe block
// that wants "not configured" mutates that object's property directly
// before importing claude.service.ts; each describe block's afterEach
// resets it back to "test-key" unconditionally afterward (not relying on
// vi.resetModules() to hand back a fresh object — safer either way, and
// cheap since it's a no-op for every test that never touched it).
vi.mock("../../src/config/env", () => ({ env: { anthropicApiKey: "test-key" } }));

// Pure unit tests — no DB needed.
describe("claude.service — generateFollowUpQuestion", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "test-key";
  });

  function mockClaudeResponse(text: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) }))
    );
  }

  it("throws a clear, catchable error when ANTHROPIC_API_KEY is not configured", async () => {
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "";
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    await expect(
      generateFollowUpQuestion({ personName: "Peggy", priorQAs: [], biographySections: [], recentCategories: [] })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  // 2026-07-19 fix — the persona eval (docs/handover_2026-07-19-qa-persona-eval.md)
  // found real follow-up repeats on a long (40-question) interview. Root
  // cause: the prompt's "don't repeat a question already asked" instruction
  // only ever had visibility into whichever answers were in priorQAs, which
  // interviews.routes.ts caps at the most recent 8 for cost reasons — so
  // anything asked earlier than that (including from the curated bank
  // itself) was invisible to the model.
  //
  // 2026-07-19 fourth fix, same day — originally fixed with priorQuestionTexts,
  // a flat, ever-growing list of every question ever asked. That grew without
  // any ceiling (Tim's real-dollar-cost question about a late-interview
  // follow-up call), so it's been replaced with biographySections: one row
  // per category, each carrying its own already-asked question stems. This
  // test now checks the same underlying guarantee — nothing asked earlier
  // than the priorQAs window goes invisible — against the new shape.
  it("includes every previously asked question's stem in the prompt via its category's biography section", async () => {
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

    // 10 questions asked in total, all one category — mirrors
    // interviews.routes.ts's real shape once an interview runs past its
    // priorAnswers cap: only the 3 most recent carry detailed answer-level
    // context, but every stem still needs to reach the prompt.
    const allTexts = Array.from({ length: 10 }, (_, i) => `Question number ${i + 1}, spelled out so it can't collide with anything else?`);
    const recentQAs = allTexts.slice(-3).map((q) => ({ question: q, answer: `Answer to: ${q}`, lifePhase: "childhood" }));

    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: recentQAs,
      biographySections: [{ lifePhase: "childhood", summary: "Grew up two streets from the rail yard.", askedQuestionStems: allTexts }],
      recentCategories: [],
    });

    expect(result).toEqual({ question: "What is a place that always feels like home to you?", lifePhase: "passions" });
    for (const q of allTexts) {
      expect(capturedPrompt).toContain(q);
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
      biographySections: [],
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
  //
  // 2026-07-19 second-order fix — this fallback now tallies from the
  // WHOLE interview rather than just the recent streak window, so the test
  // setup below reflects that: a "childhood" biography section with two
  // asked stems actually on the record, not just present in the short
  // recentCategories window.
  //
  // 2026-07-19 fourth fix, same day — the tally source is now
  // biographySections (each section's own askedQuestionStems count) rather
  // than a flat priorQuestionTexts list; same guarantee, cheaper shape.
  it("falls back to the least-used-overall known category when the response doesn't name a valid one", async () => {
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
      biographySections: [
        {
          lifePhase: "childhood",
          summary: "Grew up two streets from the rail yard.",
          askedQuestionStems: ["What was your street like?", "What was your earliest memory?"],
        },
      ],
      recentCategories: ["childhood", "childhood"],
    });

    expect(result.question).toBe("What do you remember most fondly about your grandparents?");
    // "childhood" has been used twice, everything else zero times — the
    // fallback should pick one of the untouched categories, not childhood.
    expect(result.lifePhase).not.toBe("childhood");
  });

  // 2026-07-19 second-order fix — regression guard for the actual pacing bug
  // the persona eval's grading pass caught: a category can be revisited
  // over and over with gaps in between (never 3-in-a-row, so the streak rule
  // never fires) and still end up badly over-used relative to others. This
  // checks the whole-interview tally and the new soft-ceiling/anecdote-reuse
  // instructions actually reach the prompt.
  it("includes the whole-interview category tally and the soft-ceiling / anecdote-reuse instructions in the prompt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "CATEGORY: parenthood\nQUESTION: What's a small parenting moment you still think about?" }] }),
        };
      })
    );
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");

    // Mirrors the real eval run's imbalance: passions asked 4 times,
    // parenthood never asked at all yet (no section for it at all — a
    // category with zero questions simply has no row).
    const biographySections = [
      {
        lifePhase: "passions",
        summary: "Loves 1000-piece jigsaw puzzles and still hums old jazz standards doing dishes.",
        askedQuestionStems: Array.from({ length: 4 }, (_, i) => `Passions question ${i + 1}?`),
      },
      {
        lifePhase: "community_faith",
        summary: "Faith has been a quiet thread through hard times.",
        askedQuestionStems: ["What role has faith played in your life?"],
      },
    ];

    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: [],
      biographySections,
      recentCategories: ["passions", "community_faith"],
    });

    expect(result.lifePhase).toBe("parenthood");
    expect(capturedPrompt).toContain("passions: 4");
    expect(capturedPrompt).toContain("parenthood: 0");
    expect(capturedPrompt.toLowerCase()).toContain("soft ceiling");
    expect(capturedPrompt.toLowerCase()).toContain("centerpiece of an earlier answer");
  });

  it("strips surrounding quotes from the question text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockClaudeResponse('CATEGORY: legacy\nQUESTION: "What did Sunday mornings look like in your house?"');
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    const result = await generateFollowUpQuestion({ personName: "Peggy", priorQAs: [], biographySections: [], recentCategories: [] });
    expect(result).toEqual({ question: "What did Sunday mornings look like in your house?", lifePhase: "legacy" });
  });

  it("surfaces a clear error when the Claude request fails on every retry attempt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => "internal error" }));
    vi.stubGlobal("fetch", fetchMock);
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    await expect(
      generateFollowUpQuestion({ personName: "Peggy", priorQAs: [], biographySections: [], recentCategories: [] })
    ).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // exhausted all retry attempts
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
      biographySections: [],
      recentCategories: [],
    });
    expect(result).toEqual({ question: "What does resilience mean to you?", lifePhase: "values" });
    expect(callCount).toBe(3);
  });

  // 2026-07-19 second fix, same day — a deep real interview (question 50)
  // hit "no text content" with stop_reason: max_tokens, meaning the model
  // was cut off before emitting any text at the fixed 500-token budget.
  // Plain retry at the same budget is guaranteed to fail identically every
  // time — this is the regression guard for the actual fix: a max_tokens
  // cutoff with no text should escalate the budget on retry, not just wait
  // and repeat the same request verbatim.
  it("doubles the token budget on retry after a max_tokens cutoff with no text, and succeeds once there's room", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const seenMaxTokens: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        seenMaxTokens.push(body.max_tokens);
        if (seenMaxTokens.length < 2) {
          // Cut off before any text block — the real failure shape.
          return { ok: true, json: async () => ({ content: [], stop_reason: "max_tokens" }) };
        }
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "CATEGORY: legacy\nQUESTION: What matters most to you now?" }] }),
        };
      })
    );
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: [],
      biographySections: [],
      recentCategories: [],
    });
    expect(result).toEqual({ question: "What matters most to you now?", lifePhase: "legacy" });
    expect(seenMaxTokens[0]).toBe(500); // generateFollowUpQuestion's current starting budget
    expect(seenMaxTokens[1]).toBe(1000); // doubled after the max_tokens cutoff, not retried verbatim
  });

  // 2026-07-19 third fix, same day — a live 90-question eval run hit this
  // exact shape for real at question 65: 500 -> 1000 -> 2000 all cut off
  // with zero text, exhausting the old maxAttempts=3 ladder entirely and
  // failing the whole interview request. Regression guard for the fix:
  // the ladder now has a fourth rung (4000) to actually reach.
  it("escalates through all three doublings (500 -> 1000 -> 2000 -> 4000) when the first three attempts all cut off with no text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const seenMaxTokens: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        seenMaxTokens.push(body.max_tokens);
        if (seenMaxTokens.length < 4) {
          return { ok: true, json: async () => ({ content: [], stop_reason: "max_tokens" }) };
        }
        return {
          ok: true,
          json: async () => ({ content: [{ type: "text", text: "CATEGORY: legacy\nQUESTION: What matters most to you now?" }] }),
        };
      })
    );
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    const result = await generateFollowUpQuestion({
      personName: "Peggy",
      priorQAs: [],
      biographySections: [],
      recentCategories: [],
    });
    expect(result).toEqual({ question: "What matters most to you now?", lifePhase: "legacy" });
    expect(seenMaxTokens).toEqual([500, 1000, 2000, 4000]);
  });

  it("does NOT escalate the token budget for a plain empty response (no max_tokens cutoff)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const seenMaxTokens: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        seenMaxTokens.push(body.max_tokens);
        if (seenMaxTokens.length < 2) {
          return { ok: true, json: async () => ({ content: [], stop_reason: "end_turn" }) };
        }
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "CATEGORY: legacy\nQUESTION: Anything else?" }] }) };
      })
    );
    const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
    await generateFollowUpQuestion({ personName: "Peggy", priorQAs: [], biographySections: [], recentCategories: [] });
    expect(seenMaxTokens).toEqual([500, 500]); // unchanged — this wasn't a max_tokens cutoff
  });
});

// 2026-07-19 fourth fix — the two new pure functions biography.service.ts
// calls (recordAnswerInBiography, on the write side, and the
// /interview-sessions/:id/complete handler, on the synthesis side). Both
// stay pure here — no DB — same convention as generateFollowUpQuestion.
describe("claude.service — updateBiographySectionSummary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "test-key";
  });

  it("throws a clear, catchable error when ANTHROPIC_API_KEY is not configured", async () => {
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "";
    const { updateBiographySectionSummary } = await import("../../src/services/claude.service");
    await expect(
      updateBiographySectionSummary({ personName: "Peggy", lifePhase: "childhood", existingSummary: "", question: "Q", answer: "A" })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("sends the existing summary and the new Q&A, and returns the model's updated summary text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "She grew up two streets from the rail yard and rescued a stray cat named Rusty at nine." }],
          }),
        };
      })
    );
    const { updateBiographySectionSummary } = await import("../../src/services/claude.service");

    const result = await updateBiographySectionSummary({
      personName: "Peggy",
      lifePhase: "childhood",
      existingSummary: "She grew up two streets from the rail yard.",
      question: "Did you ever have a pet growing up?",
      answer: "Yes, a stray orange tabby I rescued and named Rusty when I was nine.",
    });

    expect(result).toBe("She grew up two streets from the rail yard and rescued a stray cat named Rusty at nine.");
    expect(capturedPrompt).toContain("She grew up two streets from the rail yard.");
    expect(capturedPrompt).toContain("Did you ever have a pet growing up?");
    expect(capturedPrompt).toContain("a stray orange tabby I rescued and named Rusty");
    // The self-compression instruction — this is what keeps a section's cost
    // flat over a long interview instead of growing without bound.
    expect(capturedPrompt.toLowerCase()).toContain("no more than 5-6 sentences");
  });

  it("tells the model there's nothing yet when existingSummary is empty, rather than an empty string", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "First summary." }] }) };
      })
    );
    const { updateBiographySectionSummary } = await import("../../src/services/claude.service");
    await updateBiographySectionSummary({ personName: "Peggy", lifePhase: "childhood", existingSummary: "", question: "Q", answer: "A" });
    expect(capturedPrompt).toContain("(nothing yet)");
  });
});

describe("claude.service — synthesizeBiography", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "test-key";
  });

  it("throws a clear, catchable error when ANTHROPIC_API_KEY is not configured", async () => {
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "";
    const { synthesizeBiography } = await import("../../src/services/claude.service");
    await expect(
      synthesizeBiography({ personName: "Peggy", sections: [{ lifePhase: "childhood", summary: "Grew up by the rail yard." }] })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  // Populating persons.ai_summary with an empty/junk string would be worse
  // than leaving it null — GET /persons/:id/summary (persons.routes.ts)
  // already has an honest "generated: false" path for that case.
  it("throws rather than calling Claude when every section is empty", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { synthesizeBiography } = await import("../../src/services/claude.service");
    await expect(
      synthesizeBiography({ personName: "Peggy", sections: [{ lifePhase: "childhood", summary: "" }] })
    ).rejects.toThrow(/at least one non-empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("assembles all non-empty sections into the prompt and returns the synthesized narrative", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "Peggy grew up in a small railroad town..." }] }) };
      })
    );
    const { synthesizeBiography } = await import("../../src/services/claude.service");

    const result = await synthesizeBiography({
      personName: "Peggy",
      sections: [
        { lifePhase: "childhood", summary: "Grew up two streets from the rail yard." },
        { lifePhase: "work", summary: "" }, // no answers in this category yet — should be skipped, not passed as empty
        { lifePhase: "legacy", summary: "Hopes to be remembered as someone who listened." },
      ],
    });

    expect(result).toBe("Peggy grew up in a small railroad town...");
    expect(capturedPrompt).toContain("childhood: Grew up two streets from the rail yard.");
    expect(capturedPrompt).toContain("legacy: Hopes to be remembered as someone who listened.");
    expect(capturedPrompt).not.toContain("work:");
  });
});

// 2026-07-20 — classifies a freeform memory (share-a-memory, or a caption
// added to a photo-sourced memory — see memoryBiography.worker.ts) into one
// of the eighteen interview categories so it can be folded into the same
// running biography Q&A answers already build. A freeform memory has no
// question_id to trace a category back through the way an interview answer
// does, so something has to guess.
describe("claude.service — classifyMemoryCategory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "test-key";
  });

  it("throws a clear, catchable error when ANTHROPIC_API_KEY is not configured", async () => {
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "";
    const { classifyMemoryCategory } = await import("../../src/services/claude.service");
    await expect(classifyMemoryCategory("We lived two streets from the rail yard.")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("returns the category Claude picks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "childhood" }] }) }))
    );
    const { classifyMemoryCategory } = await import("../../src/services/claude.service");
    const result = await classifyMemoryCategory("We lived two streets from the rail yard.");
    expect(result).toBe("childhood");
  });

  // Same tolerance generateFollowUpQuestion's CATEGORY line already needs —
  // a model response isn't guaranteed to come back in exactly the requested
  // casing/whitespace.
  it("normalizes case and trailing punctuation/whitespace before matching", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "  Childhood.\n" }] }) }))
    );
    const { classifyMemoryCategory } = await import("../../src/services/claude.service");
    const result = await classifyMemoryCategory("We lived two streets from the rail yard.");
    expect(result).toBe("childhood");
  });

  it("returns null for Claude's explicit NONE response (too vague to categorize)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "NONE" }] }) }))
    );
    const { classifyMemoryCategory } = await import("../../src/services/claude.service");
    const result = await classifyMemoryCategory("Beach day!");
    expect(result).toBeNull();
  });

  it("returns null rather than throwing when the response doesn't parse into a known category", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "not-a-real-category" }] }) }))
    );
    const { classifyMemoryCategory } = await import("../../src/services/claude.service");
    const result = await classifyMemoryCategory("Something ambiguous.");
    expect(result).toBeNull();
  });

  it("includes the memory content and the full category list in the prompt", async () => {
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "work" }] }) };
      })
    );
    const { classifyMemoryCategory } = await import("../../src/services/claude.service");
    await classifyMemoryCategory("Worked at Kessler's Department Store as a teenager.");
    expect(capturedPrompt).toContain("Worked at Kessler's Department Store as a teenager.");
    expect(capturedPrompt).toContain("origins");
    expect(capturedPrompt).toContain("legacy");
    expect(capturedPrompt).toContain("NONE");
  });
});

describe("claude.service — generateClarifyingQuestion", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "test-key";
  });

  it("throws a clear, catchable error when ANTHROPIC_API_KEY is not configured", async () => {
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "";
    const { generateClarifyingQuestion } = await import("../../src/services/claude.service");
    await expect(
      generateClarifyingQuestion({ personName: "Peggy", question: "Tell me about a friend.", answer: "A friend helped out." })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("returns the clarifying question Claude generates, trimmed of surrounding quotes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: `"Do you remember her name?"` }] }) }))
    );
    const { generateClarifyingQuestion } = await import("../../src/services/claude.service");
    const result = await generateClarifyingQuestion({
      personName: "Peggy",
      question: "Tell me about a friend.",
      answer: "A friend of mine helped out that summer.",
    });
    expect(result).toBe("Do you remember her name?");
  });

  it("returns null for Claude's explicit NONE response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "NONE" }] }) }))
    );
    const { generateClarifyingQuestion } = await import("../../src/services/claude.service");
    const result = await generateClarifyingQuestion({ personName: "Peggy", question: "How was school?", answer: "Fine, nothing special." });
    expect(result).toBeNull();
  });

  it("includes the person's name, the question (when given), and the answer in the prompt", async () => {
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "NONE" }] }) };
      })
    );
    const { generateClarifyingQuestion } = await import("../../src/services/claude.service");
    await generateClarifyingQuestion({ personName: "Peggy", question: "What was your first job?", answer: "Kessler's Department Store." });
    expect(capturedPrompt).toContain("Peggy");
    expect(capturedPrompt).toContain("What was your first job?");
    expect(capturedPrompt).toContain("Kessler's Department Store.");
    expect(capturedPrompt).toContain("NONE");
  });

  it("omits the question from the prompt when it's null (open-ended answers)", async () => {
    let capturedPrompt = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        capturedPrompt = JSON.parse(init.body).messages[0].content as string;
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "NONE" }] }) };
      })
    );
    const { generateClarifyingQuestion } = await import("../../src/services/claude.service");
    await generateClarifyingQuestion({ personName: "Peggy", question: null, answer: "Just sharing a memory." });
    // Checking for the absence of a generic '("' substring was wrong — the
    // prompt's own static instructions legitimately contain that pattern
    // several times (the person/place/date examples). What actually
    // signals "no question was interpolated" is the parenthetical right
    // after "family-history interview" being omitted entirely, i.e. the
    // sentence goes straight from "interview" to the colon.
    expect(capturedPrompt).toContain("family-history interview:");
    expect(capturedPrompt).toContain("Just sharing a memory.");
  });
});

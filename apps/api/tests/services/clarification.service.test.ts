import { describe, it, expect, vi, afterEach } from "vitest";
import { withDb } from "../helpers/withDb";

// maybeOfferClarification calls claude.service.ts's generateClarifyingQuestion,
// a real Anthropic API call — stubbed the same importOriginal-based way
// biography.service.test.ts's own tests are (this file also needs a real DB
// connection through withDb(), same reasoning documented there in detail).
vi.mock("../../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/env")>();
  return { env: { ...actual.env, anthropicApiKey: "test-key" } };
});

describe("clarification.service", () => {
  const ctx = withDb();

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { env } = await import("../../src/config/env");
    env.anthropicApiKey = "test-key";
  });

  function mockClaudeQuestion(text: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) }))
    );
  }

  async function seedSession(overrides: Partial<Record<string, unknown>> = {}) {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [person] = await knex("persons").insert({ family_group_id: group.id, name: "Peggy", status: "active" }).returning("*");
    const [session] = await knex("interview_sessions")
      .insert({ person_id: person.id, facilitator_person_id: person.id, status: "in_progress", ...overrides })
      .returning("*");
    const [answer] = await knex("interview_answers")
      .insert({ session_id: session.id, audio_r2_key: "test://x" })
      .returning("*");
    return { knex, person, session, answer };
  }

  it("offers a clarifying question, increments the session count, and persists it onto the answer", async () => {
    const { maybeOfferClarification } = await import("../../src/services/clarification.service");
    const { knex, person, session, answer } = await seedSession();
    mockClaudeQuestion("Do you remember your friend's name?");

    const result = await maybeOfferClarification(knex, {
      sessionId: session.id,
      answerId: answer.id,
      isClarificationAnswer: false,
      personName: person.name,
      question: "Tell me about a friend.",
      answer: "A friend of mine helped out.",
    });

    expect(result).toBe("Do you remember your friend's name?");
    const refreshedSession = await knex("interview_sessions").where({ id: session.id }).first();
    expect(refreshedSession.clarifications_offered_count).toBe(1);
    const refreshedAnswer = await knex("interview_answers").where({ id: answer.id }).first();
    expect(refreshedAnswer.clarifying_question).toBe("Do you remember your friend's name?");
  });

  it("returns null and touches nothing when Claude says NONE", async () => {
    const { maybeOfferClarification } = await import("../../src/services/clarification.service");
    const { knex, person, session, answer } = await seedSession();
    mockClaudeQuestion("NONE");

    const result = await maybeOfferClarification(knex, {
      sessionId: session.id,
      answerId: answer.id,
      isClarificationAnswer: false,
      personName: person.name,
      question: "How was school?",
      answer: "It was fine, nothing special.",
    });

    expect(result).toBeNull();
    const refreshedSession = await knex("interview_sessions").where({ id: session.id }).first();
    expect(refreshedSession.clarifications_offered_count).toBe(0);
  });

  it("never offers a clarification on an answer that is itself a clarification (no chaining)", async () => {
    const { maybeOfferClarification } = await import("../../src/services/clarification.service");
    const { knex, person, session, answer } = await seedSession();
    mockClaudeQuestion("Something that should never be returned.");

    const result = await maybeOfferClarification(knex, {
      sessionId: session.id,
      answerId: answer.id,
      isClarificationAnswer: true,
      personName: person.name,
      question: null,
      answer: "Her name was Dorothy.",
    });

    expect(result).toBeNull();
    const refreshedSession = await knex("interview_sessions").where({ id: session.id }).first();
    expect(refreshedSession.clarifications_offered_count).toBe(0);
  });

  it("stops offering once the session-wide cap is reached", async () => {
    const { maybeOfferClarification, SESSION_CLARIFICATION_CAP } = await import("../../src/services/clarification.service");
    const { knex, person, session, answer } = await seedSession({ clarifications_offered_count: SESSION_CLARIFICATION_CAP });
    mockClaudeQuestion("Should never be reached.");

    const result = await maybeOfferClarification(knex, {
      sessionId: session.id,
      answerId: answer.id,
      isClarificationAnswer: false,
      personName: person.name,
      question: "Q",
      answer: "A",
    });

    expect(result).toBeNull();
  });

  it("stops offering once the skip streak hits the backoff threshold", async () => {
    const { maybeOfferClarification, SKIP_STREAK_BACKOFF_THRESHOLD } = await import("../../src/services/clarification.service");
    const { knex, person, session, answer } = await seedSession({ clarifications_skip_streak: SKIP_STREAK_BACKOFF_THRESHOLD });
    mockClaudeQuestion("Should never be reached.");

    const result = await maybeOfferClarification(knex, {
      sessionId: session.id,
      answerId: answer.id,
      isClarificationAnswer: false,
      personName: person.name,
      question: "Q",
      answer: "A",
    });

    expect(result).toBeNull();
  });

  it("recordClarificationSkipped increments the streak", async () => {
    const { recordClarificationSkipped } = await import("../../src/services/clarification.service");
    const { knex, session } = await seedSession();

    await recordClarificationSkipped(knex, session.id);
    await recordClarificationSkipped(knex, session.id);

    const refreshed = await knex("interview_sessions").where({ id: session.id }).first();
    expect(refreshed.clarifications_skip_streak).toBe(2);
  });

  it("recordClarificationAnswered resets the streak to 0", async () => {
    const { recordClarificationAnswered } = await import("../../src/services/clarification.service");
    const { knex, session } = await seedSession({ clarifications_skip_streak: 2 });

    await recordClarificationAnswered(knex, session.id);

    const refreshed = await knex("interview_sessions").where({ id: session.id }).first();
    expect(refreshed.clarifications_skip_streak).toBe(0);
  });
});

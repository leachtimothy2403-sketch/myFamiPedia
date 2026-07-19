import { describe, it, expect, vi, beforeEach } from "vitest";
import { withApp, registerTestUser, type TestUser } from "../helpers/withApp";
import { mockQueues, getQueueMock } from "../helpers/queueMock";

mockQueues();

// generateFollowUpQuestion and synthesizeBiography both make real Anthropic
// API calls in production — mocked here the same way this suite avoids
// other real external calls (mockQueues for BullMQ). interviews.routes.ts
// imports both directly with no dependency-injection seam, so a module mock
// is the only option (and this module mock replaces the whole module, so
// every export claude.service.ts has that interviews.routes.ts uses must be
// listed here, not just the one under direct test).
vi.mock("../../src/services/claude.service", () => ({
  generateFollowUpQuestion: vi.fn(async () => ({ question: "A generated follow-up question?", lifePhase: "passions" })),
  synthesizeBiography: vi.fn(async () => "Grandma grew up in a small town and loved her tutoring program."),
}));

describe("interviews", () => {
  const ctx = withApp();
  let user: TestUser;

  beforeEach(async () => {
    user = await registerTestUser(ctx.request);
  });

  it("lists the question bank, optionally filtered by life phase", async () => {
    await ctx.knex()("interview_questions").insert([
      { text: "Childhood Q", life_phase: "childhood", sort_order: 1 },
      { text: "Work Q", life_phase: "work", sort_order: 2 },
    ]);
    const all = await ctx.request().get("/api/v1/interview-questions").set("Authorization", `Bearer ${user.accessToken}`);
    expect(all.body).toHaveLength(2);

    const filtered = await ctx
      .request()
      .get("/api/v1/interview-questions?lifePhase=work")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].text).toBe("Work Q");
  });

  it("starts a session defaulting the subject to the caller", async () => {
    const res = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.person_id).toBe(user.personId);
    expect(res.body.facilitator_person_id).toBe(user.personId);
    expect(res.body.status).toBe("in_progress");
  });

  it("starts a session for someone else (facilitated)", async () => {
    const [grandma] = await ctx.knex()("persons").insert({ family_group_id: user.familyGroupId, name: "Grandma", status: "active" }).returning("*");
    const res = await ctx
      .request()
      .post("/api/v1/interview-sessions")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ personId: grandma.id });
    expect(res.body.person_id).toBe(grandma.id);
    expect(res.body.facilitator_person_id).toBe(user.personId);
  });

  // Closes the gap both adaptive-Q&A handover docs flagged: "no automated
  // test yet for GET /interview-questions/next... worth adding, given how
  // much the underlying logic and prompt have shifted." Written alongside
  // the 2026-07-19 fix the persona eval (docs/handover_2026-07-19-qa-persona-eval.md)
  // surfaced — see claude.service.test.ts for the prompt-construction half
  // of that fix's coverage; this file covers the route's own selection
  // logic (curated-first, generated-reuse, the priorQuestionTexts wiring).
  describe("GET /interview-questions/next", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    async function seedCuratedQuestions(count: number) {
      const rows = Array.from({ length: count }, (_, i) => ({
        text: `Curated question ${i + 1}?`,
        life_phase: "childhood",
        sort_order: i + 1,
      }));
      return ctx.knex()("interview_questions").insert(rows).returning("*");
    }

    async function createSession() {
      const res = await ctx
        .request()
        .post("/api/v1/interview-sessions")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ personId: user.personId });
      return res.body.id as string;
    }

    // Seeded directly (bypassing the real, audio-only
    // POST /interview-sessions/:id/answers) — same technique the persona
    // eval script uses, and for the same reason: GET next's own selection
    // logic is what's under test here, not the unrelated audio path.
    async function answerDirectly(sessionId: string, questionId: string, transcript: string | null) {
      await ctx.knex()("interview_answers").insert({
        session_id: sessionId,
        question_id: questionId,
        audio_r2_key: "test://not-a-real-recording",
        transcript,
      });
    }

    it("works through the curated bank in sort_order before generating anything", async () => {
      const questions = await seedCuratedQuestions(3);
      const sessionId = await createSession();

      const first = await ctx
        .request()
        .get(`/api/v1/interview-questions/next?personId=${user.personId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(first.status).toBe(200);
      expect(first.body.id).toBe(questions[0].id);

      await answerDirectly(sessionId, questions[0].id, "First answer");

      const second = await ctx
        .request()
        .get(`/api/v1/interview-questions/next?personId=${user.personId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(questions[1].id);

      const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
      expect(generateFollowUpQuestion).not.toHaveBeenCalled();
    });

    // The original regression guard for the persona-eval finding: with more
    // than 8 answered questions, the detailed priorQAs context is capped at
    // 8 on purpose (cost), but the duplicate-avoidance signal must still
    // carry every one of them, or the model loses visibility into anything
    // asked earlier and can re-ask something substantively the same (seen
    // for real: marriage-lessons asked three times over a 40-question
    // interview).
    //
    // 2026-07-19 fourth fix, same day — that duplicate-avoidance signal used
    // to be priorQuestionTexts, a flat list of every question ever asked
    // that grew without any ceiling (Tim's real-dollar-cost question about a
    // late-interview follow-up call). It's now biographySections — one row
    // per category (migration 026, biography.service.ts), each carrying its
    // own already-asked question stems — so this test seeds that table
    // directly (bypassing the real transcription pipeline the same way
    // answerDirectly already bypasses real transcription; the write side is
    // covered separately in biography.service.test.ts and
    // transcription.worker.test.ts) and checks the route reads it in full.
    it("passes the full per-category biography, not the raw question history, to generateFollowUpQuestion", async () => {
      const questions = await seedCuratedQuestions(10);
      const sessionId = await createSession();
      for (const q of questions) {
        await answerDirectly(sessionId, q.id, `Answer to ${q.text}`);
      }
      await ctx.knex()("interview_biography_sections").insert([
        {
          person_id: user.personId,
          life_phase: "childhood",
          summary: "Answered ten curated childhood questions.",
          asked_question_stems: questions.map((q: { text: string }) => q.text),
          question_count: 10,
        },
        {
          person_id: user.personId,
          life_phase: "work",
          summary: "Worked at a department store as a teenager.",
          asked_question_stems: ["What was your first job?"],
          question_count: 1,
        },
      ]);

      const res = await ctx
        .request()
        .get(`/api/v1/interview-questions/next?personId=${user.personId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);

      const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
      expect(generateFollowUpQuestion).toHaveBeenCalledTimes(1);
      const callArg = (generateFollowUpQuestion as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        priorQAs: unknown[];
        biographySections: { lifePhase: string; askedQuestionStems: string[] }[];
        recentCategories: unknown[];
      };
      expect(callArg.biographySections).toHaveLength(2);
      const childhoodSection = callArg.biographySections.find((s) => s.lifePhase === "childhood");
      expect(childhoodSection?.askedQuestionStems).toHaveLength(10);
      expect(callArg.priorQAs).toHaveLength(8);
      // recentCategories is a separate, smaller window (6) used only for the
      // "don't camp on one category" rule, not duplicate-avoidance.
      expect(callArg.recentCategories).toHaveLength(6);
    });

    // 2026-07-19 fix — every generated question used to be stored with a
    // hardcoded life_phase of "generated", meaningless for tracking which of
    // the eighteen real categories it belonged to, which made the
    // "don't stay in one category too long" rule impossible to enforce. The
    // route must persist whatever category generateFollowUpQuestion actually
    // returned, not a placeholder.
    it("stores the generated question under the real category generateFollowUpQuestion returned, not a placeholder", async () => {
      const questions = await seedCuratedQuestions(1);
      const sessionId = await createSession();
      await answerDirectly(sessionId, questions[0].id, "An answer");

      const res = await ctx
        .request()
        .get(`/api/v1/interview-questions/next?personId=${user.personId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.life_phase).toBe("passions"); // matches the module mock's return value above
      expect(res.body.life_phase).not.toBe("generated");
    });

    it("reuses an unused previously-generated question instead of calling Claude again", async () => {
      await seedCuratedQuestions(1);
      const sessionId = await createSession();
      const curated = await ctx.knex()("interview_questions").where({ source: "curated" }).first();
      await answerDirectly(sessionId, curated.id, "Answered the only curated question");

      const [existingGenerated] = await ctx
        .knex()("interview_questions")
        .insert({
          text: "An already-generated, not-yet-answered follow-up?",
          life_phase: "friendship",
          source: "generated",
          person_id: user.personId,
        })
        .returning("*");

      const res = await ctx
        .request()
        .get(`/api/v1/interview-questions/next?personId=${user.personId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(existingGenerated.id);

      const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
      expect(generateFollowUpQuestion).not.toHaveBeenCalled();
    });

    it("204s without calling Claude when curated is exhausted but nothing is transcribed yet", async () => {
      const questions = await seedCuratedQuestions(1);
      const sessionId = await createSession();
      await answerDirectly(sessionId, questions[0].id, null);

      const res = await ctx
        .request()
        .get(`/api/v1/interview-questions/next?personId=${user.personId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const { generateFollowUpQuestion } = await import("../../src/services/claude.service");
      expect(generateFollowUpQuestion).not.toHaveBeenCalled();
    });

    it("404s for a nonexistent subject person", async () => {
      const res = await ctx
        .request()
        .get(`/api/v1/interview-questions/next?personId=00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("answers", () => {
    async function startSession() {
      const res = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
      return res.body;
    }
    async function createQuestion() {
      const [q] = await ctx.knex()("interview_questions").insert({ text: "Tell me about...", life_phase: "childhood", sort_order: 1 }).returning("*");
      return q;
    }

    it("attaches an answer with mid-conversation photos staged", async () => {
      const session = await startSession();
      const question = await createQuestion();
      const [photo] = await ctx.knex()("photos").insert({ family_group_id: user.familyGroupId, r2_key: "p.jpg", uploaded_by: user.personId }).returning("*");

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${session.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "answer.mp3", photoIds: [photo.id] });
      expect(res.status).toBe(201);

      const staged = await ctx.knex()("interview_answer_photos").where({ interview_answer_id: res.body.id });
      expect(staged).toHaveLength(1);
      expect(staged[0].photo_id).toBe(photo.id);
    });

    it("requires questionId and audioR2Key", async () => {
      const session = await startSession();
      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${session.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects attaching answers to a completed session", async () => {
      const session = await startSession();
      const question = await createQuestion();
      await ctx.request().post(`/api/v1/interview-sessions/${session.id}/complete`).set("Authorization", `Bearer ${user.accessToken}`);

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${session.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "x.mp3" });
      expect(res.status).toBe(409);
    });
  });

  describe("complete", () => {
    // Same reason as the "GET /interview-questions/next" describe block
    // above: generateFollowUpQuestion and synthesizeBiography are
    // module-level vi.fn() mocks (vi.mock hoists and its factory runs once
    // per file), so call counts accumulate across tests unless cleared.
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("marks the session completed and enqueues one transcription job per answer", async () => {
      const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
      const question = await ctx.knex()("interview_questions").insert({ text: "Q", life_phase: "childhood", sort_order: 1 }).returning("*").then((r) => r[0]);

      await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "a1.mp3" });
      await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/answers`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ questionId: question.id, audioR2Key: "a2.mp3" });

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const session = await ctx.knex()("interview_sessions").where({ id: startRes.body.id }).first();
      expect(session.status).toBe("completed");
      expect(session.completed_at).not.toBeNull();

      expect(getQueueMock("transcriptionQueue").add).toHaveBeenCalledTimes(2);
    });

    it("rejects completing an already-completed session", async () => {
      const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
      await ctx.request().post(`/api/v1/interview-sessions/${startRes.body.id}/complete`).set("Authorization", `Bearer ${user.accessToken}`);
      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(409);
    });

    // 2026-07-19 fourth fix — persons.ai_summary (GET /persons/:id/summary)
    // was a stub nothing ever wrote to. Completing a session is the trigger
    // point: refresh the "who they were" legacy summary from whatever
    // biography sections exist so far, cheaply, since it's built from the
    // already-compact sections rather than the raw transcript.
    it("regenerates persons.ai_summary from the current biography sections when a session completes", async () => {
      await ctx.knex()("interview_biography_sections").insert([
        { person_id: user.personId, life_phase: "childhood", summary: "Grew up two streets from the rail yard.", asked_question_stems: ["Q1"], question_count: 1 },
        { person_id: user.personId, life_phase: "work", summary: "Worked at a department store.", asked_question_stems: ["Q2"], question_count: 1 },
      ]);
      const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const { synthesizeBiography } = await import("../../src/services/claude.service");
      expect(synthesizeBiography).toHaveBeenCalledTimes(1);
      const callArg = (synthesizeBiography as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        sections: { lifePhase: string; summary: string }[];
      };
      expect(callArg.sections).toHaveLength(2);

      const person = await ctx.knex()("persons").where({ id: user.personId }).first();
      expect(person.ai_summary).toBe("Grandma grew up in a small town and loved her tutoring program.");
    });

    it("leaves persons.ai_summary untouched when there are no biography sections yet", async () => {
      const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});

      const res = await ctx
        .request()
        .post(`/api/v1/interview-sessions/${startRes.body.id}/complete`)
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(204);

      const { synthesizeBiography } = await import("../../src/services/claude.service");
      expect(synthesizeBiography).not.toHaveBeenCalled();

      const person = await ctx.knex()("persons").where({ id: user.personId }).first();
      expect(person.ai_summary).toBeNull();
    });
  });

  it("GET returns session status with its answers", async () => {
    const startRes = await ctx.request().post("/api/v1/interview-sessions").set("Authorization", `Bearer ${user.accessToken}`).send({});
    const question = await ctx.knex()("interview_questions").insert({ text: "Q", life_phase: "childhood", sort_order: 1 }).returning("*").then((r) => r[0]);
    await ctx
      .request()
      .post(`/api/v1/interview-sessions/${startRes.body.id}/answers`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ questionId: question.id, audioR2Key: "a1.mp3" });

    const res = await ctx.request().get(`/api/v1/interview-sessions/${startRes.body.id}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.answers).toHaveLength(1);
  });

  it("404s a nonexistent session", async () => {
    const res = await ctx
      .request()
      .get(`/api/v1/interview-sessions/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(404);
  });
});

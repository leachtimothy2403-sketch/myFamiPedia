import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();
import type { TranscriptionService } from "../../src/services/transcription.service";

describe("transcription worker", () => {
  const ctx = withDb();

  it("creates a voice-provenance memory, links the subject, promotes staged photos, and updates the answer row", async () => {
    const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
    const knex = ctx.knex();

    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [subject] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Grandma", status: "active" })
      .returning("*");
    const [facilitator] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Grandchild", status: "active" })
      .returning("*");
    const [question] = await knex("interview_questions")
      .insert({ text: "What was your childhood home like?", life_phase: "childhood" })
      .returning("*");
    const [session] = await knex("interview_sessions")
      .insert({ person_id: subject.id, facilitator_person_id: facilitator.id, status: "in_progress" })
      .returning("*");
    const [answer] = await knex("interview_answers")
      .insert({ session_id: session.id, question_id: question.id, audio_r2_key: "voice/answer-1.m4a" })
      .returning("*");
    const [stagedPhoto] = await knex("photos")
      .insert({ family_group_id: group.id, r2_key: "photos/mid-interview.jpg", uploaded_by: facilitator.id })
      .returning("*");
    await knex("interview_answer_photos").insert({ interview_answer_id: answer.id, photo_id: stagedPhoto.id });

    const transcribe = vi.fn(async () => "I grew up in a small house by the river.");
    const transcription: TranscriptionService = { transcribe };
    const getBytes = vi.fn(async () => Buffer.from("fake-audio-bytes"));
    // Injected the same way transcription/getBytes are — recordBiography is
    // a real Anthropic API call in production (biography.service.ts), and
    // this test has nothing to do with Claude, so it gets a fast, offline
    // double rather than exercising the real thing.
    const recordBiography = vi.fn(async () => {});
    // offerClarification is a second real Claude call this function makes
    // (clarification.service.ts) — same offline-double reasoning, and
    // optional on TranscriptionDeps specifically so tests that don't care
    // about it (like this one) don't have to supply it.
    const offerClarification = vi.fn(async () => null);

    const result = await processTranscribeJob(
      { interviewAnswerId: answer.id },
      { transcription, getBytes, recordBiography, offerClarification }
    );

    expect(getBytes).toHaveBeenCalledWith("voice/answer-1.m4a");
    // 2026-07-20's retraction fix added a required memoryId to
    // recordAnswerInBiography's params (migration 028) — this assertion
    // went stale then (still checking the pre-memoryId shape) and would have
    // failed the moment this test file's mock actually got exercised for
    // real; caught and fixed here. objectContaining rather than an exact
    // match going forward, so a future added param doesn't silently do the
    // same thing again.
    expect(recordBiography).toHaveBeenCalledWith(
      expect.objectContaining({
        personId: subject.id,
        personName: "Grandma",
        lifePhase: "childhood",
        question: "What was your childhood home like?",
        answer: "I grew up in a small house by the river.",
        memoryId: result.memoryId,
      })
    );

    const memory = await knex("memories").where({ id: result.memoryId }).first();
    expect(memory).toBeTruthy();
    expect(memory.content).toBe("I grew up in a small house by the river.");
    expect(memory.provenance_type).toBe("voice");
    expect(memory.contributor_id).toBe(subject.id);
    expect(memory.provenance_label).toBe(question.text);

    const memoryPersons = await knex("memory_persons").where({ memory_id: result.memoryId });
    expect(memoryPersons).toHaveLength(1);
    expect(memoryPersons[0].person_id).toBe(subject.id);

    const memoryPhotos = await knex("memory_photos").where({ memory_id: result.memoryId });
    expect(memoryPhotos).toHaveLength(1);
    expect(memoryPhotos[0].photo_id).toBe(stagedPhoto.id);

    const refreshedAnswer = await knex("interview_answers").where({ id: answer.id }).first();
    expect(refreshedAnswer.transcript).toBe("I grew up in a small house by the river.");
    expect(refreshedAnswer.memory_id).toBe(result.memoryId);
  });

  // migration 021 made questionId optional on interview_answers (mobile's
  // "Share a memory" / "Start with a picture" open-ended starting points) —
  // there's no life_phase to file a biography update under in that case, so
  // recordBiography shouldn't even be attempted.
  it("skips the biography update for an open-ended answer with no question attached", async () => {
    const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
    const knex = ctx.knex();

    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [subject] = await knex("persons").insert({ family_group_id: group.id, name: "Grandma", status: "active" }).returning("*");
    const [facilitator] = await knex("persons").insert({ family_group_id: group.id, name: "Grandchild", status: "active" }).returning("*");
    const [session] = await knex("interview_sessions")
      .insert({ person_id: subject.id, facilitator_person_id: facilitator.id, status: "in_progress" })
      .returning("*");
    const [answer] = await knex("interview_answers")
      .insert({ session_id: session.id, question_id: null, audio_r2_key: "voice/answer-1.m4a" })
      .returning("*");

    const transcription: TranscriptionService = { transcribe: vi.fn(async () => "Just sharing a memory.") };
    const getBytes = vi.fn(async () => Buffer.from("fake-audio-bytes"));
    const recordBiography = vi.fn(async () => {});

    await processTranscribeJob({ interviewAnswerId: answer.id }, { transcription, getBytes, recordBiography });

    expect(recordBiography).not.toHaveBeenCalled();
  });

  // Same resilience principle as the /answers handler's synchronous-
  // transcription try/catch (interviews.routes.ts): a transcript and memory
  // that already saved successfully shouldn't be undone by a Claude hiccup
  // in the biography update that follows.
  it("doesn't fail the transcription job if the biography update throws", async () => {
    const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
    const knex = ctx.knex();

    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [subject] = await knex("persons").insert({ family_group_id: group.id, name: "Grandma", status: "active" }).returning("*");
    const [facilitator] = await knex("persons").insert({ family_group_id: group.id, name: "Grandchild", status: "active" }).returning("*");
    const [question] = await knex("interview_questions").insert({ text: "What was your first job?", life_phase: "work" }).returning("*");
    const [session] = await knex("interview_sessions")
      .insert({ person_id: subject.id, facilitator_person_id: facilitator.id, status: "in_progress" })
      .returning("*");
    const [answer] = await knex("interview_answers")
      .insert({ session_id: session.id, question_id: question.id, audio_r2_key: "voice/answer-1.m4a" })
      .returning("*");

    const transcription: TranscriptionService = { transcribe: vi.fn(async () => "Kessler's Department Store.") };
    const getBytes = vi.fn(async () => Buffer.from("fake-audio-bytes"));
    const recordBiography = vi.fn(async () => {
      throw new Error("Claude request failed (500): internal error");
    });

    const result = await processTranscribeJob({ interviewAnswerId: answer.id }, { transcription, getBytes, recordBiography });

    expect(result.transcript).toBe("Kessler's Department Store.");
    const refreshedAnswer = await knex("interview_answers").where({ id: answer.id }).first();
    expect(refreshedAnswer.transcript).toBe("Kessler's Department Store.");
  });

  // 2026-07-21/22 — the clarifying follow-up (migration 029,
  // clarification.service.ts). finalizeTranscribedAnswer (processTranscribeJob's
  // shared tail end) is the one place both the voice and text answer paths
  // funnel through, so this is where the offer gets made and persisted.
  describe("clarifying follow-up offer", () => {
    async function seedAnswer(overrides: Partial<Record<string, unknown>> = {}) {
      const knex = ctx.knex();
      const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
      const [subject] = await knex("persons").insert({ family_group_id: group.id, name: "Grandma", status: "active" }).returning("*");
      const [facilitator] = await knex("persons").insert({ family_group_id: group.id, name: "Grandchild", status: "active" }).returning("*");
      const [question] = await knex("interview_questions").insert({ text: "Tell me about a friend.", life_phase: "childhood" }).returning("*");
      const [session] = await knex("interview_sessions")
        .insert({ person_id: subject.id, facilitator_person_id: facilitator.id, status: "in_progress" })
        .returning("*");
      const [answer] = await knex("interview_answers")
        .insert({ session_id: session.id, question_id: question.id, audio_r2_key: "voice/answer-1.m4a", ...overrides })
        .returning("*");
      return { knex, session, answer, question };
    }

    it("surfaces the offered clarifying question from offerClarification on the result", async () => {
      const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
      const { answer } = await seedAnswer();
      const transcription: TranscriptionService = { transcribe: vi.fn(async () => "A friend of mine helped out that summer.") };
      const getBytes = vi.fn(async () => Buffer.from("x"));
      const recordBiography = vi.fn(async () => {});
      const offerClarification = vi.fn(async () => "Do you remember your friend's name?");

      const result = await processTranscribeJob(
        { interviewAnswerId: answer.id },
        { transcription, getBytes, recordBiography, offerClarification }
      );

      // Note: offerClarification is mocked here, standing in for the real
      // maybeOfferClarification — so it never touches the DB, and there's
      // nothing to re-query on interview_answers in this test. The actual
      // clarifying_question column write is owned by maybeOfferClarification
      // itself and is covered against the real implementation in
      // clarification.service.test.ts ("offers a clarifying question,
      // increments the session count, and persists it onto the answer").
      // This test only verifies that processTranscribeJob/finalizeTranscribedAnswer
      // calls offerClarification with the right args and surfaces its return value.
      expect(result.clarifyingQuestion).toBe("Do you remember your friend's name?");
      expect(offerClarification).toHaveBeenCalledWith(
        expect.objectContaining({ isClarificationAnswer: false, answer: "A friend of mine helped out that summer." })
      );
    });

    it("passes isClarificationAnswer: true and never offers a further clarification on a clarification's own answer", async () => {
      const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
      const { session, question } = await seedAnswer();
      const knex = ctx.knex();
      const [originalAnswer] = await knex("interview_answers")
        .insert({ session_id: session.id, question_id: question.id, audio_r2_key: "voice/original.m4a" })
        .returning("*");
      const [clarificationAnswer] = await knex("interview_answers")
        .insert({
          session_id: session.id,
          question_id: null,
          audio_r2_key: "voice/clarify.m4a",
          clarifies_answer_id: originalAnswer.id,
        })
        .returning("*");

      const transcription: TranscriptionService = { transcribe: vi.fn(async () => "Her name was Dorothy.") };
      const getBytes = vi.fn(async () => Buffer.from("x"));
      const recordBiography = vi.fn(async () => {});
      const offerClarification = vi.fn(async () => "This should never be offered again.");

      await processTranscribeJob(
        { interviewAnswerId: clarificationAnswer.id },
        { transcription, getBytes, recordBiography, offerClarification }
      );

      expect(offerClarification).toHaveBeenCalledWith(expect.objectContaining({ isClarificationAnswer: true }));
    });

    it("doesn't fail the job if the clarification offer throws", async () => {
      const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
      const { answer } = await seedAnswer();
      const transcription: TranscriptionService = { transcribe: vi.fn(async () => "Some answer.") };
      const getBytes = vi.fn(async () => Buffer.from("x"));
      const recordBiography = vi.fn(async () => {});
      const offerClarification = vi.fn(async () => {
        throw new Error("Claude request failed (500): internal error");
      });

      const result = await processTranscribeJob(
        { interviewAnswerId: answer.id },
        { transcription, getBytes, recordBiography, offerClarification }
      );
      expect(result.transcript).toBe("Some answer.");
      expect(result.clarifyingQuestion).toBeNull();
    });

    it("defaults clarifyingQuestion to null when offerClarification isn't supplied at all", async () => {
      const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
      const { answer } = await seedAnswer();
      const transcription: TranscriptionService = { transcribe: vi.fn(async () => "Some answer.") };
      const getBytes = vi.fn(async () => Buffer.from("x"));
      const recordBiography = vi.fn(async () => {});

      const result = await processTranscribeJob({ interviewAnswerId: answer.id }, { transcription, getBytes, recordBiography });
      expect(result.clarifyingQuestion).toBeNull();
    });
  });

  it("throws a clear error for an unknown interview answer id", async () => {
    const { processTranscribeJob } = await import("../../src/jobs/transcribeAnswer");
    const transcription: TranscriptionService = { transcribe: vi.fn(async () => "x") };
    const getBytes = vi.fn(async () => Buffer.from(""));

    await expect(
      processTranscribeJob({ interviewAnswerId: "00000000-0000-0000-0000-000000000000" }, { transcription, getBytes })
    ).rejects.toThrow(/not found/);
  });
});

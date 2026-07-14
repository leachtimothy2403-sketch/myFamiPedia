import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();
import type { TranscriptionService } from "../../src/services/transcription.service";

describe("transcription worker", () => {
  const ctx = withDb();

  it("creates a voice-provenance memory, links the subject, promotes staged photos, and updates the answer row", async () => {
    const { processTranscribeJob } = await import("../../src/jobs/transcription.worker");
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

    const result = await processTranscribeJob({ interviewAnswerId: answer.id }, { transcription, getBytes });

    expect(getBytes).toHaveBeenCalledWith("voice/answer-1.m4a");

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

  it("throws a clear error for an unknown interview answer id", async () => {
    const { processTranscribeJob } = await import("../../src/jobs/transcription.worker");
    const transcription: TranscriptionService = { transcribe: vi.fn(async () => "x") };
    const getBytes = vi.fn(async () => Buffer.from(""));

    await expect(
      processTranscribeJob({ interviewAnswerId: "00000000-0000-0000-0000-000000000000" }, { transcription, getBytes })
    ).rejects.toThrow(/not found/);
  });
});

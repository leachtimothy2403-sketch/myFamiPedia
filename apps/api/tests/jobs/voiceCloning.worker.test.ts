import { describe, it, expect, vi } from "vitest";
import { withDb } from "../helpers/withDb";
import { mockQueues } from "../helpers/queueMock";

mockQueues();
import type { VoiceCloneService } from "../../src/services/voiceClone.service";

describe("voice-cloning worker", () => {
  const ctx = withDb();

  async function seedPersonWithVoiceModel(modelId: string | null = null) {
    const knex = ctx.knex();
    const [group] = await knex("family_groups").insert({ name: "Test Family" }).returning("*");
    const [person] = await knex("persons")
      .insert({ family_group_id: group.id, name: "Grandpa", status: "active" })
      .returning("*");
    const [model] = await knex("voice_models")
      .insert({ person_id: person.id, tier: "instant", consent_status: "previewed", elevenlabs_model_id: modelId })
      .returning("*");
    return { group, person, model };
  }

  describe("generate-preview", () => {
    it("builds sample audio from the person's interview answers and stores the returned model id", async () => {
      const { processGeneratePreviewJob } = await import("../../src/jobs/voiceCloning.worker");
      const knex = ctx.knex();
      const { person } = await seedPersonWithVoiceModel();

      const [question] = await knex("interview_questions").insert({ text: "Q", life_phase: "childhood" }).returning("*");
      const [session] = await knex("interview_sessions")
        .insert({ person_id: person.id, facilitator_person_id: person.id, status: "in_progress" })
        .returning("*");
      await knex("interview_answers").insert({
        session_id: session.id,
        question_id: question.id,
        audio_r2_key: "voice/a1.m4a",
      });

      const createOrUpdateInstantModel = vi.fn(async () => ({ modelId: "el-model-123" }));
      const voiceClone: VoiceCloneService = {
        createOrUpdateInstantModel,
        synthesizePreviewClip: vi.fn(),
        deleteModel: vi.fn(),
      };
      const getBytes = vi.fn(async () => Buffer.from("audio-bytes"));

      const result = await processGeneratePreviewJob({ personId: person.id }, { voiceClone, getBytes });

      expect(result.modelId).toBe("el-model-123");
      expect(createOrUpdateInstantModel).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: null, name: "Grandpa" })
      );
      const refreshed = await knex("voice_models").where({ person_id: person.id }).first();
      expect(refreshed.elevenlabs_model_id).toBe("el-model-123");
    });

    it("throws a clear error when the person has no recorded interview answers yet", async () => {
      const { processGeneratePreviewJob } = await import("../../src/jobs/voiceCloning.worker");
      const { person } = await seedPersonWithVoiceModel();

      const voiceClone: VoiceCloneService = {
        createOrUpdateInstantModel: vi.fn(),
        synthesizePreviewClip: vi.fn(),
        deleteModel: vi.fn(),
      };
      const getBytes = vi.fn(async () => Buffer.from(""));

      await expect(
        processGeneratePreviewJob({ personId: person.id }, { voiceClone, getBytes })
      ).rejects.toThrow(/no recorded interview answers/);
    });
  });

  describe("delete-model", () => {
    it("deletes the ElevenLabs model and clears the local reference", async () => {
      const { processDeleteModelJob } = await import("../../src/jobs/voiceCloning.worker");
      const { person } = await seedPersonWithVoiceModel("el-model-to-delete");

      const deleteModel = vi.fn(async () => {});
      const voiceClone: VoiceCloneService = {
        createOrUpdateInstantModel: vi.fn(),
        synthesizePreviewClip: vi.fn(),
        deleteModel,
      };
      const getBytes = vi.fn(async () => Buffer.from(""));

      await processDeleteModelJob({ personId: person.id }, { voiceClone, getBytes });

      expect(deleteModel).toHaveBeenCalledWith("el-model-to-delete");
      const refreshed = await ctx.knex()("voice_models").where({ person_id: person.id }).first();
      expect(refreshed.elevenlabs_model_id).toBeNull();
      expect(refreshed.audio_seconds_accumulated).toBe(0);
    });

    it("is a no-op when no voice_models row exists", async () => {
      const { processDeleteModelJob } = await import("../../src/jobs/voiceCloning.worker");
      const deleteModel = vi.fn(async () => {});
      const voiceClone: VoiceCloneService = {
        createOrUpdateInstantModel: vi.fn(),
        synthesizePreviewClip: vi.fn(),
        deleteModel,
      };
      await expect(
        processDeleteModelJob(
          { personId: "00000000-0000-0000-0000-000000000000" },
          { voiceClone, getBytes: vi.fn() }
        )
      ).resolves.toBeUndefined();
      expect(deleteModel).not.toHaveBeenCalled();
    });
  });
});

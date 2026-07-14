import { Worker, Job } from "bullmq";
import { connection } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { voiceCloneService as defaultVoiceCloneService, VoiceCloneService } from "../services/voiceClone.service";

export interface GeneratePreviewJobData {
  personId: string;
}
export interface DeleteModelJobData {
  personId: string;
}

export interface VoiceCloningDeps {
  voiceClone: VoiceCloneService;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: VoiceCloningDeps = { voiceClone: defaultVoiceCloneService, getBytes: getObjectBuffer };

// docs/voice_pipeline.md, "Moment 1" (preview). Samples come from whatever
// interview answers already exist for this person — the only place raw
// voice audio r2 keys live in this schema. Doesn't try to fabricate
// audio_seconds_accumulated (that needs probing the actual audio file
// duration, e.g. ffprobe, which is a real piece of work of its own); this
// only updates the fields it can state accurately.
export async function processGeneratePreviewJob(
  data: GeneratePreviewJobData,
  deps: VoiceCloningDeps = defaultDeps
) {
  const { personId } = data;

  const context = await withServiceContext(async (trx) => {
    const person = await trx("persons").where({ id: personId }).first();
    if (!person) throw new Error(`Person ${personId} not found`);
    const model = await trx("voice_models").where({ person_id: personId }).first();
    if (!model) throw new Error(`No voice_models row for person ${personId} yet — the route should create one first`);
    const samples = await trx("interview_answers as a")
      .join("interview_sessions as s", "s.id", "a.session_id")
      .where("s.person_id", personId)
      .whereNotNull("a.audio_r2_key")
      .select("a.audio_r2_key")
      .limit(5);
    return { person, model, samples };
  });

  if (context.samples.length === 0) {
    throw new Error(
      `Person ${personId} has no recorded interview answers yet — nothing to build a voice preview from. Record at least one first.`
    );
  }

  const sampleAudio = await Promise.all(
    context.samples.map(async (s: { audio_r2_key: string }, i: number) => ({
      buffer: await deps.getBytes(s.audio_r2_key),
      filename: `sample-${i}.m4a`,
    }))
  );

  const { modelId } = await deps.voiceClone.createOrUpdateInstantModel({
    modelId: context.model.elevenlabs_model_id ?? null,
    name: context.person.name,
    sampleAudio,
  });

  await withServiceContext((trx) =>
    trx("voice_models").where({ person_id: personId }).update({ elevenlabs_model_id: modelId, updated_at: new Date() })
  );

  return { personId, modelId };
}

// docs/voice_pipeline.md's revoke path — permanent, server-side model
// deletion. consent_status is already set to 'revoked' by the route before
// this job even runs (voice.routes.ts's /revoke); this only handles the
// ElevenLabs-side cleanup and clears the now-dangling model id.
export async function processDeleteModelJob(data: DeleteModelJobData, deps: VoiceCloningDeps = defaultDeps) {
  const { personId } = data;
  const model = await withServiceContext((trx) => trx("voice_models").where({ person_id: personId }).first());
  if (!model) return; // nothing to delete
  if (model.elevenlabs_model_id) {
    await deps.voiceClone.deleteModel(model.elevenlabs_model_id);
  }
  await withServiceContext((trx) =>
    trx("voice_models")
      .where({ person_id: personId })
      .update({ elevenlabs_model_id: null, audio_seconds_accumulated: 0, updated_at: new Date() })
  );
}

export const voiceCloningWorker = new Worker(
  "voice-cloning",
  async (job: Job) => {
    if (job.name === "generate-preview") return processGeneratePreviewJob(job.data as GeneratePreviewJobData);
    if (job.name === "delete-model") return processDeleteModelJob(job.data as DeleteModelJobData);
    throw new Error(`Unknown voice-cloning job name: ${job.name}`);
  },
  { connection }
);

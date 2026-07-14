import { Worker, Job } from "bullmq";
import { connection, embeddingQueue } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { transcriptionService as defaultTranscriptionService, TranscriptionService } from "../services/transcription.service";

export interface TranscribeJobData {
  interviewAnswerId: string;
}

export interface TranscriptionDeps {
  transcription: TranscriptionService;
  getBytes: (r2Key: string) => Promise<Buffer>;
}

const defaultDeps: TranscriptionDeps = { transcription: defaultTranscriptionService, getBytes: getObjectBuffer };

// docs/voice_pipeline.md section 1, and the comment on interview_answer_photos
// (migration 008): "the transcription worker copies these into memory_photos
// once the memory is created." Contributor is the interview SUBJECT
// (session.person_id) — they're the one whose memory this is, the
// facilitator just asked the question — which also lines up with only the
// contributor being able to retract a voice-provenance memory later.
export async function processTranscribeJob(data: TranscribeJobData, deps: TranscriptionDeps = defaultDeps) {
  const { interviewAnswerId } = data;

  const context = await withServiceContext(async (trx) => {
    const answer = await trx("interview_answers").where({ id: interviewAnswerId }).first();
    if (!answer) throw new Error(`Interview answer ${interviewAnswerId} not found`);
    const session = await trx("interview_sessions").where({ id: answer.session_id }).first();
    if (!session) throw new Error(`Interview session ${answer.session_id} not found`);
    const person = await trx("persons").where({ id: session.person_id }).first();
    if (!person) throw new Error(`Person ${session.person_id} not found`);
    const question = await trx("interview_questions").where({ id: answer.question_id }).first();
    return { answer, session, person, question };
  });

  const audioBytes = await deps.getBytes(context.answer.audio_r2_key);
  const transcript = await deps.transcription.transcribe(audioBytes, `${interviewAnswerId}.m4a`);

  const memoryId = await withServiceContext(async (trx) => {
    const [memory] = await trx("memories")
      .insert({
        family_group_id: context.person.family_group_id,
        contributor_id: context.session.person_id,
        content: transcript,
        provenance_type: "voice",
        provenance_label: context.question?.text ?? null,
      })
      .returning("id");

    await trx("memory_persons").insert({ memory_id: memory.id, person_id: context.session.person_id });

    const stagedPhotos = await trx("interview_answer_photos").where({ interview_answer_id: interviewAnswerId });
    if (stagedPhotos.length > 0) {
      await trx("memory_photos").insert(
        stagedPhotos.map((p: { photo_id: string }) => ({ memory_id: memory.id, photo_id: p.photo_id }))
      );
    }

    await trx("interview_answers").where({ id: interviewAnswerId }).update({ transcript, memory_id: memory.id });
    return memory.id;
  });

  await embeddingQueue.add("embed-memory", { memoryId });
  return { interviewAnswerId, memoryId };
}

export const transcriptionWorker = new Worker(
  "transcription",
  async (job: Job<TranscribeJobData>) => processTranscribeJob(job.data),
  { connection }
);

// Extracted out of transcription.worker.ts so this function can be called
// two ways: (a) queued as a Q_TRANS job (the original, still used as a
// safety net — see interviews.routes.ts's /complete handler) and (b) called
// directly, synchronously, right when an answer is saved (see the /answers
// handler) so an in-progress Q&A session has real transcript text to build
// the next adaptive follow-up from without waiting for the queue.
// transcription.worker.ts itself instantiates a BullMQ Worker as a
// module-load side effect — importing that file from the API process (as
// opposed to the separate worker process, see jobs/runWorkers.ts) would
// start a second, unwanted worker competing for the same queue. Keeping the
// reusable logic here, with no Worker() call, avoids that entirely.
import { connection, embeddingQueue } from "./queue";
import { withServiceContext } from "../db/pool";
import { getObjectBuffer } from "../services/r2.service";
import { transcriptionService as defaultTranscriptionService, TranscriptionService } from "../services/transcription.service";
import { recordAnswerInBiography } from "../services/biography.service";
import { maybeOfferClarification, OfferClarificationParams } from "../services/clarification.service";

export { connection };

export interface TranscribeJobData {
  interviewAnswerId: string;
}

export interface RecordBiographyParams {
  personId: string;
  personName: string;
  lifePhase: string;
  question: string;
  answer: string;
  memoryId: string;
}

export interface TranscriptionDeps {
  transcription: TranscriptionService;
  getBytes: (r2Key: string) => Promise<Buffer>;
  // Injectable for the same reason transcription/getBytes are: this is a
  // real Anthropic API call (biography.service.ts -> claude.service.ts), and
  // tests need a fast, offline double rather than exercising it for real —
  // especially since a real ANTHROPIC_API_KEY is often present in a local
  // .env even when a given test has nothing to do with Claude.
  recordBiography: (params: RecordBiographyParams) => Promise<void>;
  // 2026-07-21/22 — optional (not every existing caller/test needs to know
  // about this), defaults to the real clarification.service.ts call below.
  // Same offline-double reasoning as recordBiography: a second real Claude
  // call this function now makes per answer.
  offerClarification?: (params: OfferClarificationParams) => Promise<string | null>;
}

const defaultDeps: TranscriptionDeps = {
  transcription: defaultTranscriptionService,
  getBytes: getObjectBuffer,
  recordBiography: (params) => withServiceContext((trx) => recordAnswerInBiography(trx, params)),
  offerClarification: (params) => withServiceContext((trx) => maybeOfferClarification(trx, params)),
};

// The shared tail end of "an answer's real text is now known" — reused by
// processTranscribeJob below (voice, once ElevenLabs returns a transcript)
// and interviews.routes.ts's /answers handler (text, which is already its
// own transcript with no transcription step at all — same principle as
// collection.routes.ts's question-prompt text path). Creates the resulting
// memory, files it into the running biography when there's a life_phase to
// file it under, and checks whether this answer is worth offering a
// clarifying follow-up on. Contributor is the interview SUBJECT
// (session.person_id) — they're the one whose memory this is, the
// facilitator just asked the question — which also lines up with only the
// contributor being able to retract a voice-provenance memory later.
export async function finalizeTranscribedAnswer(
  interviewAnswerId: string,
  transcript: string,
  provenanceType: "voice" | "text",
  deps: TranscriptionDeps = defaultDeps
) {
  const context = await withServiceContext(async (trx) => {
    const answer = await trx("interview_answers").where({ id: interviewAnswerId }).first();
    if (!answer) throw new Error(`Interview answer ${interviewAnswerId} not found`);
    const session = await trx("interview_sessions").where({ id: answer.session_id }).first();
    if (!session) throw new Error(`Interview session ${answer.session_id} not found`);
    const person = await trx("persons").where({ id: session.person_id }).first();
    if (!person) throw new Error(`Person ${session.person_id} not found`);
    const question = answer.question_id
      ? await trx("interview_questions").where({ id: answer.question_id }).first()
      : undefined;
    return { answer, session, person, question };
  });

  const memoryId = await withServiceContext(async (trx) => {
    const [memory] = await trx("memories")
      .insert({
        family_group_id: context.person.family_group_id,
        contributor_id: context.session.person_id,
        content: transcript,
        provenance_type: provenanceType,
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

  // 2026-07-19 fourth fix — keep the per-category running biography current
  // (see biography.service.ts / migration 026) right where the transcript
  // itself becomes known, so it's ready by the time the same session's next
  // GET /interview-questions/next call needs it. Skipped for open-ended
  // answers (no questionId, migration 021) — nothing to categorize under.
  // Non-fatal like the synchronous-transcription try/catch in
  // interviews.routes.ts's /answers handler: a Claude hiccup here shouldn't
  // undo a transcript and memory that already saved successfully above.
  if (context.question?.life_phase) {
    try {
      await deps.recordBiography({
        personId: context.session.person_id,
        personName: context.person.name,
        lifePhase: context.question.life_phase,
        question: context.question.text,
        answer: transcript,
        memoryId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[transcribeAnswer] biography update failed for answer ${interviewAnswerId}:`, err);
    }
  }

  // 2026-07-21/22 — the clarifying follow-up check. Independent try/catch
  // from the biography one above, same principle: a Claude hiccup here
  // shouldn't undo anything that already saved. isClarificationAnswer is
  // true when THIS answer is itself someone's response to an earlier
  // clarifying question — never chain a clarification off a clarification.
  let clarifyingQuestion: string | null = null;
  try {
    clarifyingQuestion =
      (await deps.offerClarification?.({
        sessionId: context.session.id,
        answerId: interviewAnswerId,
        isClarificationAnswer: Boolean(context.answer.clarifies_answer_id),
        personName: context.person.name,
        question: context.question?.text ?? null,
        answer: transcript,
      })) ?? null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[transcribeAnswer] clarification offer failed for answer ${interviewAnswerId}:`, err);
  }

  await embeddingQueue.add("embed-memory", { memoryId });
  return { interviewAnswerId, memoryId, transcript, clarifyingQuestion };
}

export async function processTranscribeJob(data: TranscribeJobData, deps: TranscriptionDeps = defaultDeps) {
  const { interviewAnswerId } = data;

  const answer = await withServiceContext((trx) => trx("interview_answers").where({ id: interviewAnswerId }).first());
  if (!answer) throw new Error(`Interview answer ${interviewAnswerId} not found`);

  const audioBytes = await deps.getBytes(answer.audio_r2_key);
  const transcript = await deps.transcription.transcribe(audioBytes, `${interviewAnswerId}.m4a`);

  return finalizeTranscribedAnswer(interviewAnswerId, transcript, "voice", deps);
}

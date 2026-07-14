import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { transcriptionQueue } from "../jobs/queue";
import { HttpError } from "../utils/httpError";

export const interviewsRouter = Router();

// Simple read-through of the question bank — real logic, no external dependency needed.
interviewsRouter.get("/interview-questions", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { lifePhase } = req.query;
    const rows = await withRlsContext({ personId, familyGroupId }, (trx) => {
      const q = trx("interview_questions").orderBy("sort_order");
      return lifePhase ? q.where({ life_phase: lifePhase }) : q;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Starts a facilitated session against a profile. personId in the body is
// the SUBJECT (defaults to the caller, matching mobile's "defaults to self,
// record for someone else" pattern — see docs/mobile_app_structure.md); the
// caller is always the facilitator.
interviewsRouter.post("/interview-sessions", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId: facilitatorPersonId, familyGroupId } = req.auth!;
    const subjectPersonId = req.body?.personId ?? facilitatorPersonId;
    const [session] = await withRlsContext({ personId: facilitatorPersonId, familyGroupId }, (trx) =>
      trx("interview_sessions")
        .insert({ person_id: subjectPersonId, facilitator_person_id: facilitatorPersonId, status: "in_progress" })
        .returning("*")
    );
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

// Attaches a recorded answer (audio) to a question. photoIds are photos
// captured/uploaded mid-conversation (docs/voice_pipeline.md's "Mid-
// conversation photo capture") — staged in interview_answer_photos since the
// memory this answer will become doesn't exist yet; Q_TRANS promotes them to
// memory_photos once the memory row is created (see the migration comment
// on interview_answer_photos).
interviewsRouter.post("/interview-sessions/:id/answers", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { questionId, audioR2Key, photoIds } = req.body ?? {};
    if (!questionId || !audioR2Key) {
      return res.status(400).json({ error: "questionId and audioR2Key are required" });
    }

    const answer = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const session = await trx("interview_sessions").where({ id: req.params.id }).first();
      if (!session) throw new HttpError(404, "Interview session not found");
      if (session.status !== "in_progress") throw new HttpError(409, "This session is not in progress");

      const [row] = await trx("interview_answers")
        .insert({ session_id: session.id, question_id: questionId, audio_r2_key: audioR2Key })
        .returning("*");

      if (Array.isArray(photoIds) && photoIds.length > 0) {
        await trx("interview_answer_photos").insert(
          photoIds.map((photoId: string) => ({ interview_answer_id: row.id, photo_id: photoId }))
        );
      }
      return row;
    });
    res.status(201).json(answer);
  } catch (err) {
    next(err);
  }
});

// Ends the session and enqueues one Q_TRANS job per answer — the worker (still
// stubbed) calls Whisper, writes the transcript, creates the memories row
// (provenance_type='voice'), and promotes any staged interview_answer_photos
// into memory_photos. See docs/voice_pipeline.md section 1.
interviewsRouter.post("/interview-sessions/:id/complete", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const answers = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const session = await trx("interview_sessions").where({ id: req.params.id }).first();
      if (!session) throw new HttpError(404, "Interview session not found");
      if (session.status === "completed") throw new HttpError(409, "This session has already been completed");

      await trx("interview_sessions").where({ id: session.id }).update({ status: "completed", completed_at: new Date() });
      return trx("interview_answers").where({ session_id: session.id });
    });

    await Promise.all(
      answers.map((answer: { id: string }) => transcriptionQueue.add("transcribe", { interviewAnswerId: answer.id }))
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Session status/transcript — answers embedded with their (possibly still
// null, pre-transcription) transcript text.
interviewsRouter.get("/interview-sessions/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const result = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const session = await trx("interview_sessions").where({ id: req.params.id }).first();
      if (!session) throw new HttpError(404, "Interview session not found");
      const answers = await trx("interview_answers").where({ session_id: session.id });
      return { ...session, answers };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

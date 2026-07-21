import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { transcriptionQueue } from "../jobs/queue";
import { processTranscribeJob, finalizeTranscribedAnswer } from "../jobs/transcribeAnswer";
import { HttpError } from "../utils/httpError";
import { generateFollowUpQuestion, synthesizeBiography } from "../services/claude.service";
import { getBiographySections } from "../services/biography.service";
import { recordClarificationSkipped, recordClarificationAnswered } from "../services/clarification.service";
import { env } from "../config/env";

export const interviewsRouter = Router();

// Simple read-through of the question bank — real logic, no external dependency needed.
interviewsRouter.get("/interview-questions", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { lifePhase } = req.query;
    const rows = await withRlsContext({ personId, familyGroupId }, (trx) => {
      const q = trx("interview_questions").where({ source: "curated" }).orderBy("sort_order");
      return lifePhase ? q.where({ life_phase: lifePhase }) : q;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Adaptive Q&A (docs/section2_pipeline.md section 4): work through the
// shared curated bank in sort_order first (general questions), then once
// it's exhausted for this person, generate a follow-up that digs into
// something they've actually talked about — reusing any not-yet-answered
// generated question already on file before asking Claude for a new one, so
// re-opening this screen doesn't burn a Claude call every time.
interviewsRouter.get("/interview-questions/next", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId: facilitatorPersonId, familyGroupId } = req.auth!;
    const subjectPersonId = String(req.query.personId ?? facilitatorPersonId);

    const result = await withRlsContext({ personId: facilitatorPersonId, familyGroupId }, async (trx) => {
      const person = await trx("persons").where({ id: subjectPersonId }).first();
      if (!person) throw new HttpError(404, "Person not found");

      const answeredQuestionIds = (
        await trx("interview_answers as ia")
          .join("interview_sessions as s", "s.id", "ia.session_id")
          .where({ "s.person_id": subjectPersonId })
          .whereNotNull("ia.question_id")
          .distinct("ia.question_id")
      ).map((r: { question_id: string }) => r.question_id);

      // `whereNotIn("id", [])` (nothing answered yet) used to be papered
      // over with `whereNotIn("id", [null])` — but SQL's `id NOT IN (NULL)`
      // evaluates to unknown for every row, which WHERE treats as false. So
      // on literally anyone's first-ever Q&A tap, both queries below matched
      // nothing and it fell straight through to generating a follow-up
      // before a single curated question had ever been asked. Only apply
      // the exclusion when there's actually something to exclude.
      const curatedQuery = trx("interview_questions").where({ source: "curated" }).orderBy("sort_order");
      if (answeredQuestionIds.length) curatedQuery.whereNotIn("id", answeredQuestionIds);
      const nextCurated = await curatedQuery.first();
      if (nextCurated) return nextCurated;

      const generatedQuery = trx("interview_questions")
        .where({ source: "generated", person_id: subjectPersonId })
        .orderBy("created_at", "desc");
      if (answeredQuestionIds.length) generatedQuery.whereNotIn("id", answeredQuestionIds);
      const unusedGenerated = await generatedQuery.first();
      if (unusedGenerated) return unusedGenerated;

      // Nothing left curated or on-hand — build a follow-up from this
      // person's life-story Q&A only (curated + previously generated
      // interview answers), not the broader `memories` table, which mixes
      // in unrelated freeform "share a memory"/photo content — see
      // claude.service.ts's docstring for why that was the wrong source.
      // This depends on the answer actually being transcribed already —
      // the /answers handler now transcribes synchronously on save
      // specifically so this has real text to work with within the same
      // still-open session, not just from past completed ones.
      const priorAnswers = await trx("interview_answers as ia")
        .join("interview_sessions as s", "s.id", "ia.session_id")
        .join("interview_questions as q", "q.id", "ia.question_id")
        .where({ "s.person_id": subjectPersonId })
        .whereNotNull("ia.transcript")
        .orderBy("ia.created_at", "desc")
        .limit(8)
        .select("ia.id", "q.text as question_text", "ia.transcript as answer_text", "q.life_phase as question_life_phase");

      if (priorAnswers.length === 0) {
        // No transcribed answers to build on yet (either genuinely new, or
        // transcription hasn't run — see docs/voice_pipeline.md section 1,
        // which needs ELEVENLABS_API_KEY set). Nothing to return; the client
        // falls back to the open-ended starting point instead.
        return null;
      }

      // 2026-07-19 fix, superseded 2026-07-19 fourth fix, same day — this
      // used to be a query for every question ever asked this person (text +
      // life phase, no answers), passed to generateFollowUpQuestion as
      // priorQuestionTexts so it wouldn't lose memory of anything asked
      // earlier than priorAnswers' capped-at-8 window (persona eval, real
      // 40-question run, docs/handover_2026-07-19-qa-persona-eval.md). That
      // fixed the duplicate-question problem but grew without any ceiling —
      // every question, forever, on every single follow-up prompt. Replaced
      // with the running per-category biography (migration 026,
      // biography.service.ts): same duplicate-avoidance job (each section
      // carries its own already-asked question stems), but bounded by how
      // much there is to say about a category rather than by interview
      // length. See claude.service.ts's docstring on generateFollowUpQuestion
      // for the full reasoning (Tim asked what a late-interview follow-up
      // call actually cost — this is the answer to "how do we bring that
      // down").
      const biographySections = await getBiographySections(trx, subjectPersonId);

      // 2026-07-19 fix — category spread. Recent-first category sequence
      // (chronological once reversed below) so generateFollowUpQuestion can
      // tell whether the last few questions have all been the same one of
      // the eighteen curated categories and, per Tim's direction after
      // reviewing eval output, deliberately pick something different rather
      // than staying parked on whatever's most recently discussed. A
      // smaller window than the biography sections above on purpose — this
      // is about recent momentum, not full history (that's what each
      // section's own asked-question-stems list is for).
      const recentCategoryRows = await trx("interview_answers as ia")
        .join("interview_sessions as s", "s.id", "ia.session_id")
        .join("interview_questions as q", "q.id", "ia.question_id")
        .where({ "s.person_id": subjectPersonId })
        .orderBy("ia.created_at", "desc")
        .limit(6)
        .select("q.life_phase as life_phase");
      const recentCategories = recentCategoryRows.map((r: { life_phase: string }) => r.life_phase).reverse();

      const followUp = await generateFollowUpQuestion({
        personName: person.name,
        priorQAs: priorAnswers.map((a: { question_text: string; answer_text: string; question_life_phase: string }) => ({
          question: a.question_text,
          answer: a.answer_text,
          lifePhase: a.question_life_phase,
        })),
        biographySections,
        recentCategories,
      });

      const [generated] = await trx("interview_questions")
        .insert({
          text: followUp.question,
          life_phase: followUp.lifePhase,
          source: "generated",
          person_id: subjectPersonId,
          based_on_answer_ids: priorAnswers.map((a: { id: string }) => a.id),
        })
        .returning("*");
      return generated;
    });

    if (!result) return res.status(204).send();
    res.json(result);
  } catch (err) {
    // A missing/misconfigured ANTHROPIC_API_KEY shouldn't 500 the whole
    // flow — surface it as a clear, catchable error so the client can fall
    // back to "share a memory" instead of the screen breaking.
    if (err instanceof Error && err.message.includes("ANTHROPIC_API_KEY")) {
      return res.status(503).json({ error: err.message });
    }
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

// Attaches a recorded answer to a question — audio (audioR2Key, the
// original path) or, as of 2026-07-21/22, plain text (content) as an
// alternative. photoIds are photos captured/uploaded mid-conversation
// (docs/voice_pipeline.md's "Mid-conversation photo capture") — staged in
// interview_answer_photos since the memory this answer will become doesn't
// exist yet; Q_TRANS promotes them to memory_photos once the memory row is
// created (see the migration comment on interview_answer_photos).
//
// clarifiesAnswerId marks this answer as a response to a clarifying
// follow-up offered on an earlier answer in this same session (migration
// 029) — mainly meant for a quick typed answer (a name, a date) rather than
// re-recording voice for one word, but works either way (voice clarification
// answers just pass this alongside audioR2Key). Resets the session's
// skip-streak counter, same "a real answer, not a skip" signal the skip
// endpoint below is the mirror image of.
interviewsRouter.post("/interview-sessions/:id/answers", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { questionId, audioR2Key, content, photoIds, clarifiesAnswerId } = req.body ?? {};
    if (!audioR2Key && !content) {
      return res.status(400).json({ error: "audioR2Key or content is required" });
    }

    const answer = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const session = await trx("interview_sessions").where({ id: req.params.id }).first();
      if (!session) throw new HttpError(404, "Interview session not found");
      if (session.status !== "in_progress") throw new HttpError(409, "This session is not in progress");

      if (clarifiesAnswerId) {
        const original = await trx("interview_answers").where({ id: clarifiesAnswerId, session_id: session.id }).first();
        if (!original) throw new HttpError(404, "The answer this is clarifying wasn't found in this session");
      }

      // questionId is optional — open-ended answers (mobile's "Share a
      // memory" and "Start with a picture" starting points) have no
      // specific question attached (see migration 021).
      const [row] = await trx("interview_answers")
        .insert({
          session_id: session.id,
          question_id: questionId ?? null,
          audio_r2_key: audioR2Key ?? null,
          transcript: content ?? null,
          clarifies_answer_id: clarifiesAnswerId ?? null,
        })
        .returning("*");

      if (Array.isArray(photoIds) && photoIds.length > 0) {
        await trx("interview_answer_photos").insert(
          photoIds.map((photoId: string) => ({ interview_answer_id: row.id, photo_id: photoId }))
        );
      }
      return row;
    });

    let clarifyingQuestion: string | null = null;
    if (content) {
      // Text answer — it IS its own transcript, no transcription step
      // needed, same principle as collection.routes.ts's question-prompt
      // text path. Goes straight through the same finalize logic a voice
      // answer reaches once transcribed, so biography recording and the
      // clarification check both happen the same way regardless of which
      // path an answer came in through.
      try {
        const result = await finalizeTranscribedAnswer(answer.id, content, "text");
        clarifyingQuestion = result.clarifyingQuestion;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[interviews] finalizing text answer failed for answer ${answer.id}:`, err);
      }
    } else if (env.elevenlabsApiKey && env.r2.accountId) {
      // Transcribe now, synchronously, rather than waiting for
      // /complete — GET /interview-questions/next needs this answer's real
      // text immediately to build the next adaptive follow-up within the
      // same still-open session; queuing it for later meant every "next
      // question" call during a live session only ever saw stale content
      // from previous, already-completed sessions. Adds real latency to this
      // request (a network round trip to ElevenLabs), which is an accepted
      // trade for the session screen's existing "Saving…" state. Failure
      // here (bad key, network blip) shouldn't lose the recording — the
      // audio is already safely in R2 — so it's swallowed and left to the
      // /complete handler's queue-based safety net below.
      try {
        const result = await processTranscribeJob({ interviewAnswerId: answer.id });
        clarifyingQuestion = result.clarifyingQuestion;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[interviews] synchronous transcription failed for answer ${answer.id}:`, err);
      }
    }
    // Neither branch above just means transcription isn't configured yet at
    // all (or this is a test run) — skip quietly rather than logging an
    // error on every single answer for a known, already-surfaced-elsewhere gap.

    if (clarifiesAnswerId) {
      await withRlsContext({ personId, familyGroupId }, (trx) => recordClarificationAnswered(trx, req.params.id));
    }

    res.status(201).json({ ...answer, clarifyingQuestion });
  } catch (err) {
    next(err);
  }
});

// The clarifying follow-up's skip path — deliberately as close to a no-op as
// possible (a single counter increment, see clarification.service.ts) so
// skipping is never slower or more effortful than actually answering. Two
// skips in a row (SKIP_STREAK_BACKOFF_THRESHOLD) stops clarifications from
// being offered again for the rest of this session.
interviewsRouter.post(
  "/interview-sessions/:id/answers/:answerId/skip-clarification",
  requireAuth,
  async (req: AuthedRequest, res, next) => {
    try {
      const { personId, familyGroupId } = req.auth!;
      await withRlsContext({ personId, familyGroupId }, async (trx) => {
        const session = await trx("interview_sessions").where({ id: req.params.id }).first();
        if (!session) throw new HttpError(404, "Interview session not found");
        const answer = await trx("interview_answers").where({ id: req.params.answerId, session_id: session.id }).first();
        if (!answer) throw new HttpError(404, "Answer not found in this session");
        await recordClarificationSkipped(trx, session.id);
      });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// Ends the session. Most answers are already transcribed by now — the
// /answers handler transcribes synchronously on save — this only enqueues a
// Q_TRANS job for any that aren't (transcription failed there, or this
// build still has ELEVENLABS_API_KEY unset and every answer is untranscribed),
// as a safety net rather than the primary path. See docs/voice_pipeline.md
// section 1.
interviewsRouter.post("/interview-sessions/:id/complete", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { untranscribedAnswers, subjectPersonId } = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const session = await trx("interview_sessions").where({ id: req.params.id }).first();
      if (!session) throw new HttpError(404, "Interview session not found");
      if (session.status === "completed") throw new HttpError(409, "This session has already been completed");

      await trx("interview_sessions").where({ id: session.id }).update({ status: "completed", completed_at: new Date() });
      const untranscribedAnswers = await trx("interview_answers").where({ session_id: session.id }).whereNull("transcript");
      return { untranscribedAnswers, subjectPersonId: session.person_id as string };
    });

    await Promise.all(
      untranscribedAnswers.map((answer: { id: string }) =>
        transcriptionQueue.add("transcribe", { interviewAnswerId: answer.id })
      )
    );

    // 2026-07-19 fourth fix — refresh the "who they were" legacy summary
    // (persons.ai_summary, GET /persons/:id/summary — see persons.routes.ts,
    // previously a stub nothing ever wrote to) from the current per-category
    // biography sections whenever a session wraps up. Built from the
    // already-compact sections, never the raw transcript, so this stays
    // cheap regardless of how many sessions this person has done. Non-fatal:
    // a stale or missing summary is a much smaller problem than failing
    // session completion over a Claude hiccup — same principle as the
    // synchronous-transcription try/catch in the /answers handler above.
    try {
      await withRlsContext({ personId, familyGroupId }, async (trx) => {
        const sections = await getBiographySections(trx, subjectPersonId);
        const nonEmpty = sections.filter((s) => s.summary.trim().length > 0);
        if (nonEmpty.length === 0) return;
        const person = await trx("persons").where({ id: subjectPersonId }).first();
        if (!person) return;
        const aiSummary = await synthesizeBiography({ personName: person.name, sections: nonEmpty });
        await trx("persons").where({ id: subjectPersonId }).update({ ai_summary: aiSummary, updated_at: new Date() });
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[interviews] biography synthesis failed for session ${req.params.id}:`, err);
    }

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

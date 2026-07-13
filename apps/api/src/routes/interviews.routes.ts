import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { notImplemented } from "../utils/notImplemented";

export const interviewsRouter = Router();
const spec = "docs/voice_pipeline.md";

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

interviewsRouter.post("/interview-sessions", requireAuth, notImplemented(spec));
interviewsRouter.post("/interview-sessions/:id/answers", requireAuth, notImplemented(spec));
interviewsRouter.post("/interview-sessions/:id/complete", requireAuth, notImplemented(spec));
interviewsRouter.get("/interview-sessions/:id", requireAuth, notImplemented(spec));

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const collectionRouter = Router();
const spec = "docs/section2_pipeline.md";

collectionRouter.post("/collection/camera-roll/sync", requireAuth, notImplemented(spec));
collectionRouter.get("/collection/proposed", requireAuth, notImplemented(spec));
collectionRouter.post("/collection/proposed/:id/accept", requireAuth, notImplemented(spec));
collectionRouter.post("/collection/proposed/:id/reject", requireAuth, notImplemented(spec));
collectionRouter.get("/persons/:id/privacy-tier", requireAuth, notImplemented(spec));
collectionRouter.patch("/persons/:id/privacy-tier", requireAuth, notImplemented(spec));
collectionRouter.get("/persons/:id/question-frequency", requireAuth, notImplemented(spec));
collectionRouter.patch("/persons/:id/question-frequency", requireAuth, notImplemented(spec));
collectionRouter.get("/persons/:id/question-prompt", requireAuth, notImplemented(spec));
collectionRouter.post("/question-prompt/:id/answer", requireAuth, notImplemented(spec));

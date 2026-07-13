import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const voiceRouter = Router();
const spec = "docs/voice_pipeline.md";

voiceRouter.get("/persons/:id/voice-model", requireAuth, notImplemented(spec));
voiceRouter.post("/persons/:id/voice-model/preview", requireAuth, notImplemented(spec));
// Copy convention: address the subject directly in second person, never by name in
// third person — see docs/voice_pipeline.md, "Copy convention". Applies to whatever
// text this endpoint returns for the client to render.
voiceRouter.post("/persons/:id/voice-model/consent", requireAuth, notImplemented(spec));
voiceRouter.post("/persons/:id/voice-model/pause", requireAuth, notImplemented(spec));
voiceRouter.post("/persons/:id/voice-model/revoke", requireAuth, notImplemented(spec));

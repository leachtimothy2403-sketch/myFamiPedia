import { Router } from "express";
import { requireAuth, markAsAdministratorAction } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const moderationRouter = Router();
const spec = "docs/api_structure.md#moderation";

moderationRouter.post("/flags", requireAuth, notImplemented(spec));
moderationRouter.get("/flags", requireAuth, markAsAdministratorAction, notImplemented(spec));
moderationRouter.patch("/flags/:id", requireAuth, markAsAdministratorAction, notImplemented(spec));
moderationRouter.post("/flags/:id/appeal", requireAuth, notImplemented(spec));

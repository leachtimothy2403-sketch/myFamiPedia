import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const notificationsRouter = Router();
const spec = "docs/api_structure.md#notifications";

notificationsRouter.get("/notifications", requireAuth, notImplemented(spec));
notificationsRouter.get("/notifications/settings", requireAuth, notImplemented(spec));
notificationsRouter.patch("/notifications/settings", requireAuth, notImplemented(spec));

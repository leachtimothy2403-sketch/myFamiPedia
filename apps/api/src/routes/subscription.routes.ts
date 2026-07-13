import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const subscriptionRouter = Router();
const spec = "docs/api_structure.md#subscription--family-group";

subscriptionRouter.get("/family-groups/:id/subscription", requireAuth, notImplemented(spec));
subscriptionRouter.post("/family-groups/:id/subscription/takeover", requireAuth, notImplemented(spec));

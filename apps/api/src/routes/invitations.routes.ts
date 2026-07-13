import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const invitationsRouter = Router();
const spec = "docs/invitation_flow.md";

invitationsRouter.post("/invitations", requireAuth, notImplemented(spec));
invitationsRouter.get("/invitations/:token", notImplemented(spec)); // public, no auth — see docs
invitationsRouter.post("/invitations/:token/accept", notImplemented(spec)); // public, no auth
invitationsRouter.post("/invitations/:token/decline", notImplemented(spec)); // public, no auth
invitationsRouter.post("/invitations/:id/reinvite", requireAuth, notImplemented(spec));
invitationsRouter.post("/persons/:id/opt-out", requireAuth, notImplemented(spec));
invitationsRouter.get("/persons/:id/holding-space-count", requireAuth, notImplemented(spec));

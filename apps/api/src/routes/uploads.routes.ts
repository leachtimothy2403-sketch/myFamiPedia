import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const uploadsRouter = Router();
const spec = "docs/api_structure.md#cross-cutting";

// Media never passes through Express — this issues a presigned R2 URL,
// the client uploads directly, then calls /complete to register the row.
uploadsRouter.post("/uploads/presign", requireAuth, notImplemented(spec));
uploadsRouter.post("/uploads/:id/complete", requireAuth, notImplemented(spec));

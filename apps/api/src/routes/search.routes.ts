import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notImplemented } from "../utils/notImplemented";

export const searchRouter = Router();

// mode=keyword|semantic, filters: person, date_from, date_to, media_type, contributor
// See docs/search.md for the exact SQL both modes should run — this is the one
// route where the doc already has copy-pasteable queries, implement directly from it.
searchRouter.get("/search", requireAuth, notImplemented("docs/search.md"));
searchRouter.get("/family-groups/:id/decades", requireAuth, notImplemented("docs/search.md#explore-by-decade--explore-by-person"));

import { Router } from "express";
import { requireAuth, AuthedRequest, requireFamilyAdministrator } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { HttpError } from "../utils/httpError";

export const moderationRouter = Router();

moderationRouter.post("/flags", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { contentType, contentId, description } = req.body ?? {};
    if (!contentType || !contentId || !description) {
      return res.status(400).json({ error: "contentType, contentId, and description are required" });
    }
    if (!["memory", "photo"].includes(contentType)) {
      return res.status(400).json({ error: "contentType must be 'memory' or 'photo'" });
    }
    const [flag] = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("flags")
        .insert({ content_type: contentType, content_id: contentId, reporter_person_id: personId, description })
        .returning("*")
    );
    res.status(201).json(flag);
  } catch (err) {
    next(err);
  }
});

// Administrator review queue.
moderationRouter.get("/flags", requireAuth, requireFamilyAdministrator, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { status } = req.query;
    const rows = await withRlsContext({ personId, familyGroupId, actingAsAdministrator: true }, (trx) => {
      const q = trx("flags").orderBy("created_at", "desc");
      return status ? q.where({ status: String(status) }) : q;
    });
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

// Remove/dismiss. body: { status: 'removed' | 'dismissed', resolution? }
moderationRouter.patch("/flags/:id", requireAuth, requireFamilyAdministrator, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { status, resolution } = req.body ?? {};
    if (!["removed", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "status must be 'removed' or 'dismissed'" });
    }
    const [flag] = await withRlsContext({ personId, familyGroupId, actingAsAdministrator: true }, (trx) =>
      trx("flags").where({ id: req.params.id }).update({ status, resolution: resolution ?? null }).returning("*")
    );
    if (!flag) throw new HttpError(404, "Flag not found");
    res.json(flag);
  } catch (err) {
    next(err);
  }
});

// Contributor appeals a removal with a new description — only meaningful
// from 'removed', and only by the person who originally reported... no,
// by convention this is the CONTRIBUTOR of the flagged content appealing,
// not the reporter. Since flags doesn't track "who owns the flagged content"
// directly (content_id is polymorphic across memories/photos), this checks
// ownership by looking up the referenced row's contributor/uploader.
moderationRouter.post("/flags/:id/appeal", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { description } = req.body ?? {};
    if (!description) return res.status(400).json({ error: "description is required" });

    const flag = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      const existing = await trx("flags").where({ id: req.params.id }).first();
      if (!existing) throw new HttpError(404, "Flag not found");
      if (existing.status !== "removed") throw new HttpError(409, "Only a removed flag can be appealed");

      const ownerColumn = existing.content_type === "memory" ? "contributor_id" : "uploaded_by";
      const table = existing.content_type === "memory" ? "memories" : "photos";
      const content = await trx(table).where({ id: existing.content_id }).first();
      if (!content || content[ownerColumn] !== personId) {
        throw new HttpError(403, "This appeal cannot be filed by anyone other than the content's original contributor");
      }

      const [updated] = await trx("flags")
        .where({ id: existing.id })
        .update({ status: "appealed", description })
        .returning("*");
      return updated;
    });
    res.json(flag);
  } catch (err) {
    next(err);
  }
});

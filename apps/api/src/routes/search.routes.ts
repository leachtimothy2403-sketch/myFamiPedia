import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { HttpError } from "../utils/httpError";

export const searchRouter = Router();

// mode=keyword implemented directly from docs/search.md's copy-pasteable SQL.
// mode=semantic needs a Voyage AI query embedding (src/services/voyage.service.ts,
// still a stub) — left as a clear 501 rather than a silent fallback to keyword,
// so a client can tell the difference between "no results" and "not available yet".
//
// Privacy + tenant isolation are NOT re-implemented here as extra WHERE
// clauses — per the doc, "both live in RLS policies... so a future endpoint
// can't accidentally skip the filter" (memory_privacy, migration 013). This
// query relies entirely on that policy already being correct.
searchRouter.get("/search", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { q, mode = "keyword", person, date_from, date_to, media_type, contributor } = req.query;

    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "q is required" });
    }
    if (mode !== "keyword") {
      throw new HttpError(501, "Semantic search needs a Voyage AI embedding — not implemented yet, see docs/search.md");
    }

    const results = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      let query = trx("memories")
        .select("memories.*")
        .select(trx.raw("ts_rank(to_tsvector('simple', coalesce(content,'')), plainto_tsquery('simple', ?)) AS rank", [q]))
        .whereRaw("to_tsvector('simple', coalesce(content,'')) @@ plainto_tsquery('simple', ?)", [q]);

      if (person) {
        query = query
          .leftJoin("memory_persons", "memory_persons.memory_id", "memories.id")
          .where((qb) => qb.where("memories.contributor_id", String(person)).orWhere("memory_persons.person_id", String(person)));
      }
      if (date_from) query = query.where("memories.event_date", ">=", String(date_from));
      if (date_to) query = query.where("memories.event_date", "<=", String(date_to));
      if (media_type) query = query.where("memories.provenance_type", String(media_type));
      if (contributor) query = query.where("memories.contributor_id", String(contributor));

      return query.distinct().orderBy("rank", "desc");
    });

    res.json({ items: results });
  } catch (err) {
    next(err);
  }
});

// Pre-aggregated browse view, not search in the query sense. family_groups
// has no RLS (see subscription.routes.ts's note), so this checks membership
// at the app layer the same way; the underlying memories query still runs
// through withRlsContext so memory_privacy/tenant-isolation apply.
searchRouter.get("/family-groups/:id/decades", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { personId, familyGroupId } = req.auth!;
    if (req.params.id !== familyGroupId) {
      throw new HttpError(403, "This family group's decades view cannot be read by anyone outside it");
    }
    const rows = await withRlsContext({ personId, familyGroupId }, (trx) =>
      trx("memories")
        .select(trx.raw("date_trunc('decade', event_date) AS decade"))
        .count("* as count")
        .whereNotNull("event_date")
        .groupBy("decade")
        .orderBy("decade", "asc")
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

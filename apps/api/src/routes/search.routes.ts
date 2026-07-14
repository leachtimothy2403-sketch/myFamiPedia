import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { withRlsContext } from "../db/pool";
import { HttpError } from "../utils/httpError";
import { embeddingService as defaultEmbeddingService, EmbeddingService } from "../services/embeddings.service";

export const searchRouter = Router();

// mode=keyword implemented directly from docs/search.md's copy-pasteable SQL.
//
// Privacy + tenant isolation are NOT re-implemented here as extra WHERE
// clauses — per the doc, "both live in RLS policies... so a future endpoint
// can't accidentally skip the filter" (memory_privacy, migration 013). This
// query relies entirely on that policy already being correct.
searchRouter.get(
  "/search",
  requireAuth,
  async (req: AuthedRequest, res, next) => searchHandler(req, res, next, defaultEmbeddingService)
);

// Exported with an injectable EmbeddingService so tests can exercise
// semantic mode against a fake rather than a real Voyage API key.
export async function searchHandler(
  req: AuthedRequest,
  res: import("express").Response,
  next: import("express").NextFunction,
  embeddings: EmbeddingService
) {
  try {
    const { personId, familyGroupId } = req.auth!;
    const { q, mode = "keyword", person, date_from, date_to, media_type, contributor } = req.query;

    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "q is required" });
    }

    if (mode === "keyword") {
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

      return res.json({ items: results });
    }

    if (mode !== "semantic") {
      return res.status(400).json({ error: "mode must be 'keyword' or 'semantic'" });
    }

    // Query embedding generated once, in text mode, by the same
    // voyage-multimodal-3.5 endpoint that embedded memories/photos — same
    // model, same space, so the two <=> comparisons below are meaningful
    // against each other (docs/search.md).
    const [queryEmbedding] = await embeddings.embedText([q]);
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;

    // media_type has a different meaning here than in keyword mode: since
    // semantic mode unions two tables (memories and photos), "photo" picks
    // out the photos-table leg entirely ("ask for 'photos only' results
    // from the same combined search" per the doc), while any other value is
    // still a memories.provenance_type filter restricting to just that leg.
    const wantsPhotosOnly = media_type === "photo";
    const memoriesProvenanceFilter = media_type && !wantsPhotosOnly ? String(media_type) : undefined;

    const results = await withRlsContext({ personId, familyGroupId }, async (trx) => {
      let memoryQuery = trx("memories")
        .select(
          trx.raw("'memory' AS result_type"),
          "memories.id",
          trx.raw("content AS preview"),
          "event_date",
          trx.raw("1 - (embedding <=> ?::vector) AS similarity", [vectorLiteral])
        )
        .whereNotNull("embedding");

      let photoQuery = trx("photos")
        .select(
          trx.raw("'photo' AS result_type"),
          "photos.id",
          trx.raw("r2_key AS preview"),
          trx.raw("taken_at AS event_date"),
          trx.raw("1 - (embedding <=> ?::vector) AS similarity", [vectorLiteral])
        )
        .whereNotNull("embedding");

      if (person) {
        memoryQuery = memoryQuery
          .leftJoin("memory_persons", "memory_persons.memory_id", "memories.id")
          .where((qb) => qb.where("memories.contributor_id", String(person)).orWhere("memory_persons.person_id", String(person)))
          .distinct();
        photoQuery = photoQuery
          .leftJoin("photo_persons", "photo_persons.photo_id", "photos.id")
          .where((qb) => qb.where("photos.uploaded_by", String(person)).orWhere("photo_persons.person_id", String(person)))
          .distinct();
      }
      if (date_from) {
        memoryQuery = memoryQuery.where("memories.event_date", ">=", String(date_from));
        photoQuery = photoQuery.where("photos.taken_at", ">=", String(date_from));
      }
      if (date_to) {
        memoryQuery = memoryQuery.where("memories.event_date", "<=", String(date_to));
        photoQuery = photoQuery.where("photos.taken_at", "<=", String(date_to));
      }
      if (contributor) {
        memoryQuery = memoryQuery.where("memories.contributor_id", String(contributor));
        photoQuery = photoQuery.where("photos.uploaded_by", String(contributor));
      }
      if (memoriesProvenanceFilter) memoryQuery = memoryQuery.where("memories.provenance_type", memoriesProvenanceFilter);

      if (wantsPhotosOnly) return photoQuery.orderBy("similarity", "desc").limit(20);
      if (memoriesProvenanceFilter) return memoryQuery.orderBy("similarity", "desc").limit(20);
      return memoryQuery.unionAll(photoQuery).orderBy("similarity", "desc").limit(20);
    });

    res.json({ items: results });
  } catch (err) {
    next(err);
  }
}

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

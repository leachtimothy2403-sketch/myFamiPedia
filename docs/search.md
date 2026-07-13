# myFamiPedia — Search Implementation (pgvector)

Two layers, one table (`memories`), one endpoint (`GET /search`), mode-switched.

## Keyword search (MVP)

Standard Postgres full-text search — no new infra:
```sql
SELECT id, content, ts_rank(to_tsvector('simple', content), query) AS rank
FROM memories, plainto_tsquery('simple', :q) query
WHERE to_tsvector('simple', content) @@ query
  AND family_group_id = :family_group_id
ORDER BY rank DESC;
```
GIN index on the tsvector expression (already in the data model doc) keeps this fast at family scale (thousands, not millions, of rows). Add `pg_trgm` + a trigram index on `persons.name` for fuzzy name matching ("Grandma Rose" vs "Rose") — cheap to add, meaningfully improves recall on names and places.

## Semantic search — text AND photos (early post-MVP)

**Decided: Voyage AI `voyage-multimodal-3.5`**, 1024-dim, for both text and image embeddings. The reason this beats a text-only model (OpenAI `text-embedding-3-small` etc.) for this product specifically: it uses one encoder for text, images, and video, so a query like "cooking" retrieves a genuinely relevant *photo* directly — not just text that happens to mention cooking. Dual-encoder (CLIP-style) models suffer a "modality gap" where text queries cluster near other text and under-retrieve images even when the image is the better match; a single shared encoder avoids that. This is the feature the doc's search section asks for ("searches across transcripts, photo descriptions, memory text, tags simultaneously") without needing a photo-captioning workaround.

**Embedding pipeline (`Q_EMBED` worker), two triggers:**
- `memories` insert/update → embed `content` (+ transcript for voice memories) in **text mode** → write `memories.embedding`.
- `photos` upload complete → embed the image directly from its R2 object in **image mode** → write `photos.embedding`. No caption-generation step — the photo's pixels are embedded as-is, in the same space as text.

**Query path — union across both tables, ranked together:**
```sql
(
  SELECT 'memory' AS result_type, id, content AS preview, event_date,
         1 - (embedding <=> :query_embedding) AS similarity
  FROM memories
  WHERE family_group_id = :family_group_id
)
UNION ALL
(
  SELECT 'photo' AS result_type, id, r2_key AS preview, taken_at AS event_date,
         1 - (embedding <=> :query_embedding) AS similarity
  FROM photos
  WHERE family_group_id = :family_group_id
)
ORDER BY similarity DESC
LIMIT 20;
```
The query embedding is generated once, in text mode, by the same `voyage-multimodal-3.5` endpoint — that's what makes the two `<=>` comparisons meaningful against each other (same model, same space, so similarity scores are on the same scale and can be merged/sorted together instead of running two separate searches and stitching results heuristically).

`result_type` tells the client whether to render a memory card or a photo thumbnail. `ivfflat` cosine indexes on both `memories.embedding` and `photos.embedding` (in the data model doc) keep this sub-100ms at family scale; skip the index and brute-force at true MVP volume (low thousands of rows per family) and add it once a family's archive grows.

**Cost reality check:** text side is $0.12/M tokens (multimodal-3.5's text rate — pricier than the text-only `voyage-4` at $0.06/M, that's the premium for the shared-space capability); image side is $0.60/billion pixels, which works out to roughly $0.0006 per typical 1000×1000 photo. A family of 20 uploading, say, 3,000 photos over several years costs under $2 total to embed. 200M free text tokens per account covers memory/transcript embedding for a long time regardless.

## Combined behavior

`GET /search?q=&mode=keyword|semantic&person=&date_from=&date_to=&media_type=&contributor=`:
1. `mode` picks the query above.
2. Filters (`person`, `date_from/to`, `media_type`, `contributor`) are applied as `WHERE` clauses before ranking, on both paths — same filter logic shared in one query-builder function so keyword and semantic results are filtered identically.
3. **Privacy is enforced as a mandatory join/predicate on every search query, not a post-filter** — `is_private = false OR contributor_id = :requesting_person_id OR :requesting_person_id IN (SELECT person_id FROM memory_persons WHERE memory_id = memories.id)` for `memories`, and the equivalent `photos.is_private = false OR uploaded_by = :requesting_person_id OR :requesting_person_id IN (SELECT person_id FROM photo_persons WHERE photo_id = photos.id)` for the photo leg of the union. Both live in RLS policies (see privacy-enforcement doc) so a future endpoint can't accidentally skip the filter.
4. `media_type` filter narrows to just the `memories` leg, just the `photos` leg, or both — lets the client ask for "photos only" results from the same combined search.

## "Explore by decade" / "explore by person"

Not search in the query sense — these are pre-aggregated browse views:
- `GET /family-groups/:id/decades` → `SELECT date_trunc('decade', event_date), count(*) FROM memories GROUP BY 1`.
- `GET /persons/:id/memories` (already in API doc) doubles as "explore by person."

Both can reuse the same privacy predicate as search.

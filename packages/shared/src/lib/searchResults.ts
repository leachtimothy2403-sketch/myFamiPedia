export type SearchResultType = "memory" | "photo";

export interface NormalizedSearchResult {
  id: string;
  resultType: SearchResultType;
  preview: string | null;
  eventDate: string | null;
  score: number | null;
  contributorId: string | null;
}

// The API's two search modes return different shapes (apps/api's
// search.routes.ts searchHandler): keyword mode returns full `memories.*`
// rows (camelCased by ApiClient.parse) plus `rank`, all from one table so
// every row has a contributorId; semantic mode returns a pre-normalized
// { resultType, id, preview, eventDate, similarity } union across memories
// and photos, with no contributor id selected in that query at all. This
// flattens both into one shape so a results list never needs to branch on
// which mode ran, and never fabricates a contributorId that mode didn't
// actually provide.
export function normalizeSearchResults(
  items: unknown[],
  mode: "keyword" | "semantic"
): NormalizedSearchResult[] {
  if (mode === "semantic") {
    return (items as Array<Record<string, unknown>>).map((it) => ({
      id: String(it.id),
      resultType: (it.resultType as SearchResultType) ?? "memory",
      preview: typeof it.preview === "string" ? it.preview : null,
      eventDate: typeof it.eventDate === "string" ? it.eventDate : null,
      score: typeof it.similarity === "number" ? it.similarity : null,
      contributorId: null,
    }));
  }
  return (items as Array<Record<string, unknown>>).map((it) => ({
    id: String(it.id),
    resultType: "memory",
    preview: typeof it.content === "string" ? it.content : null,
    eventDate: typeof it.eventDate === "string" ? it.eventDate : null,
    score: typeof it.rank === "number" ? it.rank : null,
    contributorId: typeof it.contributorId === "string" ? it.contributorId : null,
  }));
}

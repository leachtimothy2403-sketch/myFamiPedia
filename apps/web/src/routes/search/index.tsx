import { useState } from "react";
import { Link } from "react-router-dom";
import type { SearchQueryInput } from "@myfamipedia/shared";
import { normalizeSearchResults } from "@myfamipedia/shared";
import { useSearch } from "../../hooks/useSearch";

type MediaFilter = "" | "photo" | "text" | "voice";
type Mode = "keyword" | "semantic";

const MEDIA_OPTIONS: { value: MediaFilter; label: string }[] = [
  { value: "", label: "All types" },
  { value: "text", label: "Text" },
  { value: "photo", label: "Photo" },
  { value: "voice", label: "Voice" },
];

// No frontend existed for this at all before — the API (keyword full-text
// search + semantic pgvector search, apps/api's search.routes.ts) was fully
// built and tested, just unreachable from either client. mode defaults to
// keyword here rather than the API's own default of "semantic", since
// semantic mode depends on a live embeddings API call succeeding
// (docs/search.md) and keyword doesn't — a safer first experience.
export default function SearchRoute() {
  const [q, setQ] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<SearchQueryInput | null>(null);
  const [mode, setMode] = useState<Mode>("keyword");
  const [mediaType, setMediaType] = useState<MediaFilter>("");

  const { data, isLoading, isError, error } = useSearch(submittedQuery);

  const results = data
    ? normalizeSearchResults((data as { items: unknown[] }).items ?? [], submittedQuery?.mode ?? "keyword")
    : [];

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    setSubmittedQuery({ q: trimmed, mode, mediaType: mediaType || undefined });
  }

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <Link to="/tree" style={{ fontSize: 14 }}>
        ← Back to tree
      </Link>
      <h1>Search</h1>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search memories…"
          style={{ flex: 1, minWidth: 200, padding: 8 }}
        />
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="keyword">Keyword</option>
          <option value="semantic">Semantic (AI)</option>
        </select>
        <select value={mediaType} onChange={(e) => setMediaType(e.target.value as MediaFilter)}>
          {MEDIA_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
      </form>

      {isLoading ? <p>Searching…</p> : null}
      {isError ? (
        <p style={{ color: "#b3261e" }}>
          {error instanceof Error
            ? error.message
            : "Search failed. Semantic mode needs a working embeddings API — try Keyword instead."}
        </p>
      ) : null}
      {!isLoading && !isError && submittedQuery && results.length === 0 ? <p>No results.</p> : null}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {results.map((r) => (
          <li key={`${r.resultType}-${r.id}`} style={{ borderBottom: "1px solid #eee", padding: "10px 0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontSize: 11, color: "#888", textTransform: "uppercase" }}>{r.resultType}</span>
              {r.eventDate ? <span style={{ fontSize: 12, color: "#888" }}>{r.eventDate}</span> : null}
            </div>
            <p style={{ margin: "4px 0" }}>{r.resultType === "photo" ? "Photo" : r.preview ?? "(no text)"}</p>
            {r.contributorId ? (
              <Link to={`/person/${r.contributorId}`} style={{ fontSize: 12 }}>
                View contributor
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

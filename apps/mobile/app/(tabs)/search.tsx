import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { SearchQueryInput, NormalizedSearchResult } from "@myfamipedia/shared";
import { normalizeSearchResults } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";

type MediaFilter = "" | "photo" | "text" | "voice";
type Mode = "keyword" | "semantic";

const MEDIA_OPTIONS: { value: MediaFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "text", label: "Text" },
  { value: "photo", label: "Photo" },
  { value: "voice", label: "Voice" },
];

function ResultRow({ item }: { item: NormalizedSearchResult }) {
  return (
    <TouchableOpacity
      disabled={!item.contributorId}
      onPress={() => item.contributorId && router.push(`/person/${item.contributorId}`)}
      style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#eee" }}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
        <Text style={{ fontSize: 11, color: "#888", textTransform: "uppercase" }}>{item.resultType}</Text>
        {item.eventDate ? <Text style={{ fontSize: 12, color: "#888" }}>{item.eventDate}</Text> : null}
      </View>
      <Text style={{ marginTop: 2 }}>{item.resultType === "photo" ? "Photo" : item.preview ?? "(no text)"}</Text>
      {item.contributorId ? (
        <Text style={{ fontSize: 12, color: "#1a73e8", marginTop: 2 }}>View contributor</Text>
      ) : null}
    </TouchableOpacity>
  );
}

// No screen existed for this at all before — the API (keyword full-text +
// semantic pgvector search, apps/api's search.routes.ts) was fully built
// and tested but unreachable from either client. Mode defaults to keyword
// since semantic mode depends on a live embeddings API call succeeding
// (docs/search.md) and keyword doesn't. Mobile's counterpart to
// apps/web's routes/search/index.tsx — same normalizeSearchResults()
// utility from @myfamipedia/shared handles both platforms' result shapes.
export default function SearchScreen() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<Mode>("keyword");
  const [mediaType, setMediaType] = useState<MediaFilter>("");
  const [submittedQuery, setSubmittedQuery] = useState<SearchQueryInput | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["search", submittedQuery],
    queryFn: () => apiClient.search(submittedQuery as SearchQueryInput),
    enabled: submittedQuery !== null,
  });

  const results = data
    ? normalizeSearchResults((data as { items: unknown[] }).items ?? [], submittedQuery?.mode ?? "keyword")
    : [];

  function onSubmit() {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSubmittedQuery({ q: trimmed, mode, mediaType: mediaType || undefined });
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <TextInput
        placeholder="Search memories…"
        value={q}
        onChangeText={setQ}
        onSubmitEditing={onSubmit}
        returnKeyType="search"
        style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 8, marginBottom: 8 }}
      />

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
        {(["keyword", "semantic"] as Mode[]).map((m) => (
          <TouchableOpacity key={m} onPress={() => setMode(m)}>
            <Text style={{ fontWeight: mode === m ? "700" : "400" }}>
              {m === "keyword" ? "Keyword" : "Semantic (AI)"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ flexDirection: "row", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        {MEDIA_OPTIONS.map((o) => (
          <TouchableOpacity key={o.value} onPress={() => setMediaType(o.value)}>
            <Text style={{ fontWeight: mediaType === o.value ? "700" : "400", fontSize: 13 }}>{o.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        onPress={onSubmit}
        style={{ backgroundColor: "#1a73e8", paddingVertical: 10, borderRadius: 6, alignItems: "center", marginBottom: 12 }}
      >
        <Text style={{ color: "white", fontWeight: "600" }}>Search</Text>
      </TouchableOpacity>

      {isLoading ? <ActivityIndicator /> : null}
      {isError ? (
        <Text style={{ color: "#b3261e", marginBottom: 8 }}>
          {error instanceof Error
            ? error.message
            : "Search failed. Semantic mode needs a working embeddings API — try Keyword instead."}
        </Text>
      ) : null}

      <FlatList
        data={results}
        keyExtractor={(item) => `${item.resultType}-${item.id}`}
        renderItem={({ item }) => <ResultRow item={item} />}
        ListEmptyComponent={
          !isLoading && submittedQuery ? <Text style={{ color: "#888" }}>No results.</Text> : null
        }
      />
    </View>
  );
}

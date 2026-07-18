import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Memory } from "@myfamipedia/shared";
import { apiClient } from "../../../lib/apiClient";
import { getFamilyGroupId } from "../../../lib/session";
import { ProfileHeader } from "../../../components/profile/ProfileHeader";
import { LifeTimeline } from "../../../components/profile/LifeTimeline";
import { MemoriesFeed } from "../../../components/profile/MemoriesFeed";
import { ConnectionsPanel } from "../../../components/profile/ConnectionsPanel";
import { AddMemoryForm } from "../../../components/profile/AddMemoryForm";

// Full profile: timeline + memories feed + connections, wide layout.
// Relationships/names come from the same ["family-tree", familyGroupId]
// query TreeRoute uses — an instant cache hit if you got here by clicking a
// node on the tree, one extra fetch if you landed here directly (e.g. via a
// bookmarked/shared link).
export default function PersonProfileRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const familyGroupId = getFamilyGroupId();

  const { data: person, isLoading: personLoading, isError: personError } = useQuery({
    queryKey: ["person", id],
    queryFn: () => apiClient.getPerson(id),
  });

  const { data: tree } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });

  // excludeVoice=true: this feed is for memories someone specifically chose
  // to enter, not raw Q&A/story recordings — see the route's comment in
  // apps/api/src/routes/persons.routes.ts.
  const { data: memories } = useQuery({
    queryKey: ["person-memories", id],
    queryFn: () => apiClient.request<{ items: Memory[] }>(`/persons/${id}/memories?excludeVoice=true`),
  });

  const { data: timeline } = useQuery({
    queryKey: ["person-timeline", id],
    queryFn: () => apiClient.request<{ items: Memory[] }>(`/persons/${id}/timeline`),
  });

  if (personLoading) return <p style={{ padding: 24 }}>Loading…</p>;
  if (personError || !person) return <p style={{ padding: 24 }}>Couldn't load this profile.</p>;

  const timelineEvents = (timeline?.items ?? []).map((m: Memory) => ({
    id: m.id,
    date: m.eventDate,
    label: m.content ?? (m.mediaUrl ? "Photo memory" : "Memory"),
  }));

  return (
    <div style={{ padding: 24 }}>
      <Link to="/tree" style={{ fontSize: 14 }}>
        ← Back to tree
      </Link>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 24, marginTop: 12 }}>
        <div>
          <ProfileHeader person={person} />
          <LifeTimeline events={timelineEvents} />
          <AddMemoryForm personId={id} />
          <MemoriesFeed memories={memories?.items ?? []} />
        </div>
        <aside>
          <ConnectionsPanel profileId={id} relationships={tree?.relationships ?? []} persons={tree?.persons ?? []} />
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 4 }}>
            <Link to={`/person/${id}/ask`}>Ask about {person.name}</Link>
            <Link to={`/person/${id}/edit`}>Edit profile</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

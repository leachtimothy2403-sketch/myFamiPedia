import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../../../lib/apiClient";
import { ProfileHeader } from "../../../components/profile/ProfileHeader";
import { LifeTimeline } from "../../../components/profile/LifeTimeline";
import { MemoriesFeed } from "../../../components/profile/MemoriesFeed";
import { ConnectionsPanel } from "../../../components/profile/ConnectionsPanel";

// Full profile: timeline + memories feed + connections, wide layout.
export default function PersonProfileRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const { data: person } = useQuery({ queryKey: ["person", id], queryFn: () => apiClient.getPerson(id) });
  const { data: memories } = useQuery({
    queryKey: ["person-memories", id],
    queryFn: () => apiClient.request<{ items: any[] }>(`/persons/${id}/memories`),
  });
  const { data: timeline } = useQuery({
    queryKey: ["person-timeline", id],
    queryFn: () => apiClient.request<{ items: any[] }>(`/persons/${id}/timeline`),
  });

  if (!person) return <p>Loading…</p>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 24, padding: 24 }}>
      <div>
        <ProfileHeader person={person as any} />
        <LifeTimeline events={timeline?.items ?? []} />
        <MemoriesFeed memories={memories?.items ?? []} />
      </div>
      <aside>
        <ConnectionsPanel relationships={[]} />
        <Link to={`/person/${id}/ask`}>Ask</Link>
        <br />
        <Link to={`/person/${id}/edit`}>Edit</Link>
      </aside>
    </div>
  );
}

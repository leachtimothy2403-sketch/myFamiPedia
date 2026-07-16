interface TimelineEvent {
  id: string;
  date: string | null;
  label: string;
}

interface LifeTimelineProps {
  events: TimelineEvent[];
}

// Dumb/presentational on purpose — the route maps raw Memory rows (which
// have `content`/`eventDate`, not `label`) into this shape, so this
// component doesn't need to know about the Memory type at all.
export function LifeTimeline({ events }: LifeTimelineProps) {
  if (events.length === 0) {
    return <p style={{ color: "#888", fontSize: 14 }}>No dated memories yet.</p>;
  }
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16 }}>Timeline</h2>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, borderLeft: "2px solid #e0e0e0" }}>
        {events.map((e) => (
          <li key={e.id} style={{ padding: "6px 0 6px 16px", position: "relative" }}>
            <span
              style={{
                position: "absolute",
                left: -5,
                top: 12,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#8ab4f8",
              }}
            />
            <strong style={{ fontSize: 13, color: "#555" }}>{e.date ?? "Undated"}</strong>
            <div>{e.label}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

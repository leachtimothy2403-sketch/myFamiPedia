interface TimelineEvent {
  id: string;
  date: string | null;
  label: string;
}

interface LifeTimelineProps {
  events: TimelineEvent[];
}

export function LifeTimeline({ events }: LifeTimelineProps) {
  return (
    <ol>
      {events.map((e) => (
        <li key={e.id}>
          {e.date ?? "Undated"} — {e.label}
        </li>
      ))}
    </ol>
  );
}

import type { Relationship } from "@myfamipedia/shared";

interface ConnectionsPanelProps {
  relationships: Relationship[];
}

export function ConnectionsPanel({ relationships }: ConnectionsPanelProps) {
  return (
    <ul>
      {relationships.map((r) => (
        <li key={r.id}>{r.relationshipType}</li>
      ))}
    </ul>
  );
}

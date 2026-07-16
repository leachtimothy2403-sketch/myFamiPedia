import { Link } from "react-router-dom";
import type { Person, Relationship, RelationshipType } from "@myfamipedia/shared";

interface ConnectionsPanelProps {
  profileId: string;
  relationships: Relationship[];
  persons: Person[];
}

// Relationship rows are directional (personAId <verb> personBId) and carry
// no names — phrase each one from the viewed profile's point of view, and
// resolve the other side's name from the family-group persons list, rather
// than showing the raw relationship_type + a bare id.
const FORWARD_LABEL: Record<RelationshipType, string> = {
  parent_of: "Parent of",
  child_of: "Child of",
  spouse_of: "Spouse of",
  sibling_of: "Sibling of",
  other: "Related to",
};
const REVERSE_LABEL: Record<RelationshipType, string> = {
  parent_of: "Child of",
  child_of: "Parent of",
  spouse_of: "Spouse of",
  sibling_of: "Sibling of",
  other: "Related to",
};

export function ConnectionsPanel({ profileId, relationships, persons }: ConnectionsPanelProps) {
  const personById = new Map(persons.map((p) => [p.id, p]));

  const connections = relationships
    .map((r) => {
      const isForward = r.personAId === profileId;
      const otherId = isForward ? r.personBId : r.personAId;
      const other = personById.get(otherId);
      if (!other) return null;
      const label = (isForward ? FORWARD_LABEL : REVERSE_LABEL)[r.relationshipType] ?? "Related to";
      return { id: r.id, otherId, name: other.name, label };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <div>
      <h2 style={{ fontSize: 16 }}>Connections</h2>
      {connections.length === 0 ? (
        <p style={{ color: "#888", fontSize: 14 }}>No connections yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {connections.map((c) => (
            <li key={c.id} style={{ padding: "4px 0" }}>
              <span style={{ color: "#666", fontSize: 13 }}>{c.label}</span>{" "}
              <Link to={`/person/${c.otherId}`}>{c.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { Person, Relationship } from "@myfamipedia/shared";
import { PersonNode } from "./PersonNode";
import { RelationshipEdge } from "./RelationshipEdge";

interface TreeCanvasProps {
  persons: Person[];
  relationships: Relationship[];
  onSelectPerson?: (personId: string) => void;
}

// Generational-row layout (compute generation depth via relationships BFS
// from a root person), SVG render with virtualization for large trees.
// Recommended over force-directed layout for predictability — see
// docs/web_app_structure.md's "Rendering approach for the tree".
export function TreeCanvas({ persons, relationships, onSelectPerson }: TreeCanvasProps) {
  return (
    <svg viewBox="0 0 1000 600" style={{ width: "100%", height: "100%" }}>
      {relationships.map((r) => (
        <RelationshipEdge key={r.id} relationship={r} />
      ))}
      {persons.map((p, i) => (
        <PersonNode key={p.id} person={p} x={100 + (i % 8) * 110} y={100 + Math.floor(i / 8) * 120} onSelect={onSelectPerson} />
      ))}
    </svg>
  );
}

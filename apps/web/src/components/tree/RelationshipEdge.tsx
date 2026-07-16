import type { Relationship } from "@myfamipedia/shared";

interface RelationshipEdgeProps {
  relationship: Relationship;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Coordinates come from the parent TreeCanvas's generational layout pass
// (lib/treeLayout.ts) — this component only draws the line, styled by
// relationship type: spouse_of connects two people on the same row (dashed,
// so it reads differently from a parent/child line even before you look at
// direction), everything else spans generations.
export function RelationshipEdge({ relationship, x1, y1, x2, y2 }: RelationshipEdgeProps) {
  const isSpouse = relationship.relationshipType === "spouse_of";
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={isSpouse ? "#c58af9" : "#9aa5b1"}
      strokeWidth={isSpouse ? 2 : 1.5}
      strokeDasharray={isSpouse ? "4 3" : undefined}
    />
  );
}

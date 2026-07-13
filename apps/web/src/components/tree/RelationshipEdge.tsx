import type { Relationship } from "@myfamipedia/shared";

interface RelationshipEdgeProps {
  relationship: Relationship;
}

// Actual endpoint coordinates come from the parent TreeCanvas's layout pass;
// this stub just establishes the component boundary.
export function RelationshipEdge(_props: RelationshipEdgeProps) {
  return null;
}

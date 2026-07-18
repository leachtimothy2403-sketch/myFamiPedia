import { Line } from "react-native-svg";
import type { Relationship } from "@myfamipedia/shared";

interface RelationshipEdgeProps {
  relationship: Relationship;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Mobile port of apps/web/src/components/tree/RelationshipEdge.tsx — same
// styling rule (dashed purple for spouse_of, solid grey for everything else)
// so the two platforms read the same way.
export function RelationshipEdge({ relationship, x1, y1, x2, y2 }: RelationshipEdgeProps) {
  const isSpouse = relationship.relationshipType === "spouse_of";
  return (
    <Line
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

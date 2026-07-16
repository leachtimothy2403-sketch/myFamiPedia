import { useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import type { Person, Relationship } from "@myfamipedia/shared";
import { PersonNode } from "./PersonNode";
import { RelationshipEdge } from "./RelationshipEdge";
import { layoutFamilyTree } from "../../lib/treeLayout";

interface TreeCanvasProps {
  persons: Person[];
  relationships: Relationship[];
  rootPersonId?: string | null;
  onSelectPerson?: (personId: string) => void;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 700;

// Pan/zoom graph, generational layout — the primary canvas everything else
// lives on (docs/web_app_structure.md). Layout math lives in lib/treeLayout;
// this component owns rendering plus pan (drag) and zoom (wheel), both
// simple transforms on a wrapping <g> rather than a canvas/webgl engine —
// plenty for the tree sizes this product expects at launch.
export function TreeCanvas({ persons, relationships, rootPersonId, onSelectPerson }: TreeCanvasProps) {
  const { positions, width } = useMemo(
    () => layoutFamilyTree(persons, relationships, rootPersonId ?? null),
    [persons, relationships, rootPersonId]
  );

  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOrigin = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  function onWheel(e: ReactWheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setTransform((t) => ({ ...t, scale: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.scale * factor)) }));
  }

  function onMouseDown(e: ReactMouseEvent<SVGSVGElement>) {
    dragOrigin.current = { startX: e.clientX, startY: e.clientY, originX: transform.x, originY: transform.y };
    setIsDragging(true);
  }

  function onMouseMove(e: ReactMouseEvent<SVGSVGElement>) {
    if (!dragOrigin.current) return;
    const { startX, startY, originX, originY } = dragOrigin.current;
    setTransform((t) => ({ ...t, x: originX + (e.clientX - startX), y: originY + (e.clientY - startY) }));
  }

  function endDrag() {
    dragOrigin.current = null;
    setIsDragging(false);
  }

  if (persons.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#666" }}>
        No one in the tree yet.
      </div>
    );
  }

  // Center the layout's bounding box horizontally in the viewBox.
  const centerX = VIEWBOX_WIDTH / 2 - width / 2;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      style={{ width: "100%", height: "100%", cursor: isDragging ? "grabbing" : "grab", background: "#fafafa" }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
        <g transform={`translate(${centerX}, 80)`}>
          {relationships.map((r) => {
            const from = positions.get(r.personAId);
            const to = positions.get(r.personBId);
            if (!from || !to) return null;
            return <RelationshipEdge key={r.id} relationship={r} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
          })}
          {[...positions.values()].map(({ person, x, y }) => (
            <PersonNode
              key={person.id}
              person={person}
              x={x}
              y={y}
              isRoot={person.id === rootPersonId}
              onSelect={onSelectPerson}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}

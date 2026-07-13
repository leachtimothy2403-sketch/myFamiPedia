import type { Person } from "@myfamipedia/shared";

interface PersonNodeProps {
  person: Person;
  x: number;
  y: number;
  onSelect?: (personId: string) => void;
}

export function PersonNode({ person, x, y, onSelect }: PersonNodeProps) {
  return (
    <g transform={`translate(${x}, ${y})`} onClick={() => onSelect?.(person.id)} style={{ cursor: "pointer" }}>
      <circle r={28} fill={person.status === "deceased" ? "#ccc" : "#8ab4f8"} />
      <text textAnchor="middle" dy={44} fontSize={12}>
        {person.name}
      </text>
    </g>
  );
}

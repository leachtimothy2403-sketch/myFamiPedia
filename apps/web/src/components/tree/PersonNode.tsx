import type { Person } from "@myfamipedia/shared";

interface PersonNodeProps {
  person: Person;
  x: number;
  y: number;
  isRoot?: boolean;
  onSelect?: (personId: string) => void;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function lifespan(person: Person): string | null {
  const birthYear = person.birthDate?.slice(0, 4);
  const deathYear = person.deathDate?.slice(0, 4);
  if (!birthYear && !deathYear) return null;
  if (person.status === "deceased") return `${birthYear ?? "?"}–${deathYear ?? "?"}`;
  return birthYear ? `b. ${birthYear}` : null;
}

export function PersonNode({ person, x, y, isRoot, onSelect }: PersonNodeProps) {
  const years = lifespan(person);
  return (
    <g transform={`translate(${x}, ${y})`} onClick={() => onSelect?.(person.id)} style={{ cursor: "pointer" }}>
      <circle
        r={28}
        fill={person.status === "deceased" ? "#ccc" : "#8ab4f8"}
        stroke={isRoot ? "#1a73e8" : "none"}
        strokeWidth={isRoot ? 3 : 0}
      />
      <text textAnchor="middle" dy={4} fontSize={11} fill="#1a1a1a">
        {initials(person.name)}
      </text>
      <text textAnchor="middle" dy={44} fontSize={12} fontWeight={isRoot ? 600 : 400}>
        {person.name}
      </text>
      {years ? (
        <text textAnchor="middle" dy={58} fontSize={10} fill="#666">
          {years}
        </text>
      ) : null}
    </g>
  );
}

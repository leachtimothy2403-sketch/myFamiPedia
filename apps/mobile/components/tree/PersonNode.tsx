import { Circle, G, Text as SvgText } from "react-native-svg";
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

// Mobile port of apps/web/src/components/tree/PersonNode.tsx using
// react-native-svg instead of DOM <svg>. Node currently shows initials in
// place of a photo — there's no profile-picture/avatar concept in the data
// model yet (photo tagging is person<->photo via face coordinates, not a
// single "primary photo" field, and the R2/Rekognition pipeline behind it is
// still blocked on credentials per docs/media_pipeline.md). Once a person has
// a resolvable photo URL, swap the <Circle>+initials <SvgText> below for an
// <Image>/<ClipPath> avatar — x/y/radius here won't need to change.
export function PersonNode({ person, x, y, isRoot, onSelect }: PersonNodeProps) {
  const years = lifespan(person);
  return (
    <G x={x} y={y} onPress={() => onSelect?.(person.id)}>
      <Circle
        r={28}
        fill={person.status === "deceased" ? "#ccc" : "#8ab4f8"}
        stroke={isRoot ? "#1a73e8" : "none"}
        strokeWidth={isRoot ? 3 : 0}
      />
      <SvgText textAnchor="middle" y={4} fontSize={11} fill="#1a1a1a">
        {initials(person.name)}
      </SvgText>
      <SvgText textAnchor="middle" y={44} fontSize={12} fontWeight={isRoot ? "600" : "400"} fill="#1a1a1a">
        {person.name}
      </SvgText>
      {years ? (
        <SvgText textAnchor="middle" y={58} fontSize={10} fill="#666">
          {years}
        </SvgText>
      ) : null}
    </G>
  );
}

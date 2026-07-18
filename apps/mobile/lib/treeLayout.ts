import type { Person, Relationship } from "@myfamipedia/shared";

export interface PositionedPerson {
  person: Person;
  x: number;
  y: number;
  generation: number;
}

export interface LayoutResult {
  positions: Map<string, PositionedPerson>;
  width: number;
  height: number;
}

const COLUMN_SPACING = 150;
const ROW_SPACING = 160;
const ROW_HEIGHT_PADDING = 100;

// Mobile port of apps/web/src/lib/treeLayout.ts's generational-row layout —
// same BFS-from-root approach and the same x/y pixel math, so the "Structure"
// tab's canvas (components/tree/TreeCanvas.tsx) lines up visually with web's
// tree page. Kept as its own copy rather than importing from web, matching
// the existing precedent in lib/treeGrouping.ts (which duplicates the BFS
// generation pass for the list view) rather than sharing across apps.
export function layoutFamilyTree(
  persons: Person[],
  relationships: Relationship[],
  rootPersonId: string | null
): LayoutResult {
  const personById = new Map(persons.map((p) => [p.id, p]));

  const adjacency = new Map<string, { to: string; delta: number }[]>();
  for (const p of persons) adjacency.set(p.id, []);

  function link(a: string, b: string, delta: number) {
    adjacency.get(a)?.push({ to: b, delta });
    adjacency.get(b)?.push({ to: a, delta: -delta });
  }

  for (const r of relationships) {
    if (!personById.has(r.personAId) || !personById.has(r.personBId)) continue;
    if (r.relationshipType === "parent_of") link(r.personAId, r.personBId, 1);
    else if (r.relationshipType === "child_of") link(r.personAId, r.personBId, -1);
    else link(r.personAId, r.personBId, 0); // spouse_of, sibling_of, other
  }

  const generation = new Map<string, number>();
  const root = rootPersonId && personById.has(rootPersonId) ? rootPersonId : persons[0]?.id;
  if (root) {
    generation.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      const currentGen = generation.get(current)!;
      for (const { to, delta } of adjacency.get(current) ?? []) {
        if (!generation.has(to)) {
          generation.set(to, currentGen + delta);
          queue.push(to);
        }
      }
    }
  }
  for (const p of persons) {
    if (!generation.has(p.id)) generation.set(p.id, 0);
  }

  const rows = new Map<number, Person[]>();
  for (const p of persons) {
    const g = generation.get(p.id)!;
    if (!rows.has(g)) rows.set(g, []);
    rows.get(g)!.push(p);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.name.localeCompare(b.name));
  }

  const sortedGenerations = [...rows.keys()].sort((a, b) => a - b);
  const positions = new Map<string, PositionedPerson>();
  let maxRowWidth = 0;

  sortedGenerations.forEach((gen, rowIndex) => {
    const row = rows.get(gen)!;
    const rowWidth = (row.length - 1) * COLUMN_SPACING;
    maxRowWidth = Math.max(maxRowWidth, rowWidth);
    row.forEach((p, i) => {
      const x = i * COLUMN_SPACING - rowWidth / 2;
      const y = rowIndex * ROW_SPACING;
      positions.set(p.id, { person: p, x, y, generation: gen });
    });
  });

  return {
    positions,
    width: maxRowWidth,
    height: sortedGenerations.length * ROW_SPACING + ROW_HEIGHT_PADDING,
  };
}

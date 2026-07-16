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

// Generational-row layout: compute generation depth via BFS from a root
// person, rather than a force simulation — see docs/web_app_structure.md's
// "Rendering approach for the tree" ("more predictable, more 'family
// tree'-looking, easier to keep stable across re-renders as data changes").
//
// parent_of/child_of move a generation up or down; spouse_of/sibling_of/other
// keep two people on the same row. Anyone not reachable from the root (a
// disconnected branch — e.g. a spouse's side not yet linked back) still gets
// a row rather than being dropped from the tree.
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

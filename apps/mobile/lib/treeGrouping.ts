import type { Person, Relationship } from "@myfamipedia/shared";

export interface GenerationGroup {
  generation: number;
  label: string;
  persons: Person[];
}

// Same BFS approach as apps/web/src/lib/treeLayout.ts, minus the x/y pixel
// layout — mobile's tree tab is a simplified read-mostly view of the same
// data (sectioned list by generation), not the full pan/zoom canvas web
// gets. See docs/web_app_structure.md's intro.
export function groupByGeneration(
  persons: Person[],
  relationships: Relationship[],
  rootPersonId: string | null
): GenerationGroup[] {
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

  const groups = new Map<number, Person[]>();
  for (const p of persons) {
    const g = generation.get(p.id)!;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gen, list]) => ({ generation: gen, label: generationLabel(gen), persons: list }));
}

function generationLabel(gen: number): string {
  if (gen === 0) return "You & this generation";
  if (gen < 0) return `${-gen} generation${gen < -1 ? "s" : ""} up`;
  return `${gen} generation${gen > 1 ? "s" : ""} down`;
}

export interface DecadeGroup {
  decade: string;
  persons: Person[];
}

export function groupByDecade(persons: Person[]): DecadeGroup[] {
  const groups = new Map<string, Person[]>();
  const unknown: Person[] = [];
  for (const p of persons) {
    if (!p.birthDate) {
      unknown.push(p);
      continue;
    }
    const year = Number(p.birthDate.slice(0, 4));
    const decade = `${Math.floor(year / 10) * 10}s`;
    if (!groups.has(decade)) groups.set(decade, []);
    groups.get(decade)!.push(p);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const sorted = [...groups.entries()].sort(([a], [b]) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  const result: DecadeGroup[] = sorted.map(([decade, list]) => ({ decade, persons: list }));
  if (unknown.length) {
    result.push({ decade: "Unknown", persons: unknown.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return result;
}

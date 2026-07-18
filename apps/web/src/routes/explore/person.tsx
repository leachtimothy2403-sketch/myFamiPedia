import { useState } from "react";
import { Link } from "react-router-dom";
import { useFamilyTree } from "../../hooks/useFamilyTree";
import { getFamilyGroupId } from "../../lib/session";

// Searchable flat list — the desktop equivalent of mobile tree.tsx's
// "By person" segmented-control mode.
// Was useFamilyTree("me") — "me" isn't a real family group id, and
// GET /family-groups/:id/tree (apps/api's persons.routes.ts) queries
// Postgres with it directly rather than checking req.auth first, so this
// would fail with an invalid-UUID database error rather than a clean 403.
// Fixed the same way the tree tab and today's other "me" bugs were fixed.
export default function ExplorePersonRoute() {
  const { data } = useFamilyTree(getFamilyGroupId() ?? "");
  const [query, setQuery] = useState("");
  const persons = ((data as any)?.persons ?? []).filter((p: any) =>
    p.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div style={{ padding: 24 }}>
      <input placeholder="Search family members…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul>
        {persons.map((p: any) => (
          <li key={p.id}>
            <Link to={`/person/${p.id}`}>{p.name}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

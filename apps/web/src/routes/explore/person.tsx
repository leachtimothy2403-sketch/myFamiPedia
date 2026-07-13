import { useState } from "react";
import { Link } from "react-router-dom";
import { useFamilyTree } from "../../hooks/useFamilyTree";

// Searchable flat list — the desktop equivalent of mobile tree.tsx's
// "By person" segmented-control mode.
export default function ExplorePersonRoute() {
  const { data } = useFamilyTree("me");
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

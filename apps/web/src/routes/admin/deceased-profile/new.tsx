import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Person, RelationshipType } from "@myfamipedia/shared";
import { apiClient } from "../../../lib/apiClient";
import { getFamilyGroupId } from "../../../lib/session";

const RELATION_OPTIONS: { label: string; value: RelationshipType }[] = [
  { label: "child", value: "parent_of" },
  { label: "parent", value: "child_of" },
  { label: "spouse", value: "spouse_of" },
  { label: "sibling", value: "sibling_of" },
  { label: "other relative", value: "other" },
];

// Section 4 entry point — administrator-only, no invitation created. Was
// missing relationshipType/relatedToPersonId entirely — POST
// /persons/deceased requires both (apps/api's persons.routes.ts: "name,
// deathDate, relationshipType, and relatedToPersonId are required"), so
// every submission through this form 400'd. AddFamilyMemberPanel's
// deceased branch (the tree page's inline panel) always collected these
// correctly; this standalone route just never did.
export default function NewDeceasedProfileRoute() {
  const navigate = useNavigate();
  const familyGroupId = getFamilyGroupId();
  const { data: tree } = useQuery({
    queryKey: ["family-tree", familyGroupId],
    queryFn: () => apiClient.getFamilyTree(familyGroupId ?? ""),
    enabled: Boolean(familyGroupId),
  });
  const persons = tree?.persons ?? [];

  const [name, setName] = useState("");
  const [relatedToPersonId, setRelatedToPersonId] = useState("");
  const [relationshipType, setRelationshipType] = useState<RelationshipType>("parent_of");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const effectiveRelatedToId = relatedToPersonId || persons[0]?.id;
    if (!name.trim() || !deathDate || !effectiveRelatedToId) {
      setError("Name, death date, and relation are required.");
      return;
    }
    try {
      const person = await apiClient.request<{ id: string }>("/persons/deceased", {
        method: "POST",
        body: {
          name: name.trim(),
          relationshipType,
          relatedToPersonId: effectiveRelatedToId,
          birthDate: birthDate || null,
          deathDate,
        },
      });
      navigate(`/person/${person.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this profile");
    }
  }

  return (
    <form onSubmit={create} style={{ padding: 24, maxWidth: 360 }}>
      <h1>Create a profile in memory of…</h1>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />

      <label style={{ fontSize: 12, color: "#555", display: "block", marginTop: 8 }}>
        This person is my
        <select
          value={relationshipType}
          onChange={(e) => setRelationshipType(e.target.value as RelationshipType)}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        >
          {RELATION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label style={{ fontSize: 12, color: "#555", display: "block", marginTop: 8 }}>
        relative to
        <select
          value={relatedToPersonId || persons[0]?.id || ""}
          onChange={(e) => setRelatedToPersonId(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        >
          {persons.map((p: Person) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <input
        placeholder="Birth date (YYYY-MM-DD)"
        value={birthDate}
        onChange={(e) => setBirthDate(e.target.value)}
        style={{ display: "block", marginTop: 8 }}
      />
      <input
        placeholder="Death date (YYYY-MM-DD)"
        value={deathDate}
        onChange={(e) => setDeathDate(e.target.value)}
        style={{ display: "block", marginTop: 8 }}
      />
      <button type="submit" style={{ marginTop: 8 }}>
        Create profile
      </button>
      {error ? <p style={{ color: "#b3261e", fontSize: 13 }}>{error}</p> : null}
    </form>
  );
}

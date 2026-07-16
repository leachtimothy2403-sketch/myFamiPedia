import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Person, RelationshipType } from "@myfamipedia/shared";
import { apiClient } from "../../lib/apiClient";

interface AddFamilyMemberPanelProps {
  familyGroupId: string;
  persons: Person[];
  defaultRelatedToId: string | null;
  onClose: () => void;
}

// Relationship phrased from the anchor person's point of view ("New person
// is my ___") rather than the raw relationship_type direction — much easier
// to reason about in a form than "personA parent_of personB". Mapped to the
// actual column value the API expects (relatedToPersonId is always personA
// — see invitations.routes.ts / persons.routes.ts's POST /persons/deceased).
const RELATION_OPTIONS: { label: string; value: RelationshipType }[] = [
  { label: "child", value: "parent_of" },
  { label: "parent", value: "child_of" },
  { label: "spouse", value: "spouse_of" },
  { label: "sibling", value: "sibling_of" },
  { label: "other relative", value: "other" },
];

export function AddFamilyMemberPanel({ familyGroupId, persons, defaultRelatedToId, onClose }: AddFamilyMemberPanelProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [relatedToPersonId, setRelatedToPersonId] = useState(defaultRelatedToId ?? persons[0]?.id ?? "");
  const [relationshipType, setRelationshipType] = useState<RelationshipType>("parent_of");
  const [isDeceased, setIsDeceased] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!name.trim() || !relatedToPersonId) {
      setError("Name and relation are required.");
      return;
    }
    if (isDeceased && !deathDate) {
      setError("Date of death is required for a deceased profile.");
      return;
    }

    setSubmitting(true);
    try {
      if (isDeceased) {
        await apiClient.addDeceasedProfile({
          name: name.trim(),
          relationshipType,
          relatedToPersonId,
          birthDate: birthDate || null,
          deathDate,
        });
        setResult(`${name.trim()} was added to the tree.`);
      } else {
        const res = await apiClient.inviteFamilyMember({
          name: name.trim(),
          relationshipType,
          relatedToPersonId,
          inviteeEmail: email || null,
          inviteePhone: phone || null,
        });
        setResult(
          res.shareableLink
            ? `${name.trim()} was added. Share this invite link with them: ${res.shareableLink}`
            : `${name.trim()} was added and invited.`
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["family-tree", familyGroupId] });
      setName("");
      setEmail("");
      setPhone("");
      setBirthDate("");
      setDeathDate("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add family member");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        width: 320,
        background: "white",
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 16,
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>Add family member</strong>
        <button onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />

        <label style={{ fontSize: 12, color: "#555" }}>
          New person is my
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

        <label style={{ fontSize: 12, color: "#555" }}>
          relative to
          <select
            value={relatedToPersonId}
            onChange={(e) => setRelatedToPersonId(e.target.value)}
            style={{ display: "block", width: "100%", marginTop: 4 }}
          >
            {persons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={isDeceased} onChange={(e) => setIsDeceased(e.target.checked)} />
          This person has passed away
        </label>

        {isDeceased ? (
          <>
            <label style={{ fontSize: 12, color: "#555" }}>
              Birth date (optional)
              <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} style={{ display: "block", width: "100%" }} />
            </label>
            <label style={{ fontSize: 12, color: "#555" }}>
              Death date
              <input type="date" value={deathDate} onChange={(e) => setDeathDate(e.target.value)} style={{ display: "block", width: "100%" }} />
            </label>
          </>
        ) : (
          <>
            <input placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Adding…" : "Add to tree"}
        </button>
      </form>

      {result ? <p style={{ fontSize: 12, color: "#1a7a3c", wordBreak: "break-all" }}>{result}</p> : null}
      {error ? <p style={{ fontSize: 12, color: "#b3261e" }}>{error}</p> : null}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { apiClient } from "../../../lib/apiClient";

// Self or administrator-only edit — enforced server-side via RLS. Pre-fills
// from the existing profile (PATCH /persons/:id already accepts birthDate/
// deathDate/profileData, this form just didn't expose them before).
export default function PersonEditRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getPerson(id)
      .then((person) => {
        if (cancelled) return;
        setName(person.name);
        setBirthDate(person.birthDate ?? "");
        setDeathDate(person.deathDate ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load this profile"))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiClient.request(`/persons/${id}`, {
        method: "PATCH",
        body: { name, birthDate: birthDate || null, deathDate: deathDate || null },
      });
      navigate(`/person/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes");
      setSaving(false);
    }
  }

  if (loading) return <p style={{ padding: 24 }}>Loading…</p>;

  return (
    <div style={{ padding: 24, maxWidth: 360 }}>
      <Link to={`/person/${id}`} style={{ fontSize: 14 }}>
        ← Back to profile
      </Link>
      <h1 style={{ fontSize: 20 }}>Edit profile</h1>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ fontSize: 12, color: "#555" }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ display: "block", width: "100%" }} />
        </label>
        <label style={{ fontSize: 12, color: "#555" }}>
          Date of birth
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label style={{ fontSize: 12, color: "#555" }}>
          Date of death (leave blank if living)
          <input
            type="date"
            value={deathDate}
            onChange={(e) => setDeathDate(e.target.value)}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {error ? <p style={{ color: "#b3261e", fontSize: 13 }}>{error}</p> : null}
      </form>
    </div>
  );
}

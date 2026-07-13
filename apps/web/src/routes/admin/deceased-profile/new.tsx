import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient } from "../../../lib/apiClient";

// Section 4 entry point — administrator-only, no invitation created.
export default function NewDeceasedProfileRoute() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const person = await apiClient.request<{ id: string }>("/persons/deceased", {
      method: "POST",
      body: { name, birthDate: birthDate || null, deathDate: deathDate || null },
    });
    navigate(`/person/${person.id}`);
  }

  return (
    <form onSubmit={create} style={{ padding: 24, maxWidth: 360 }}>
      <h1>Create a profile in memory of…</h1>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Birth date (YYYY-MM-DD)" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      <input placeholder="Death date (YYYY-MM-DD)" value={deathDate} onChange={(e) => setDeathDate(e.target.value)} />
      <button type="submit">Create profile</button>
    </form>
  );
}

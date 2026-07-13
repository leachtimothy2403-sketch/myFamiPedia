import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiClient } from "../../../lib/apiClient";

// Self or administrator-only edit — enforced server-side via RLS.
export default function PersonEditRoute() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await apiClient.request(`/persons/${id}`, { method: "PATCH", body: { name } });
    navigate(`/person/${id}`);
  }

  return (
    <form onSubmit={save} style={{ padding: 24 }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <button type="submit">Save</button>
    </form>
  );
}

import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiClient } from "../lib/apiClient";

// Mirrors apps/mobile/app/(auth)/register.tsx. Not in docs/web_app_structure.md's
// route list, but something has to create the first person + family group —
// invite links only cover joining an existing one. Same /auth/register
// endpoint mobile uses.
export default function RegisterRoute() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function onRegister(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiClient.register({ name, email, password, language: "en" });
      navigate("/tree");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Registration failed");
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1>Create your family's space</h1>
      <form onSubmit={onRegister} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit">Create account</button>
      </form>
      <p>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
      {message ? <p>{message}</p> : null}
    </div>
  );
}

import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { apiClient } from "../lib/apiClient";

// Password or magic-link email sign-in — same /auth/* endpoints as mobile.
export default function LoginRoute() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiClient.login({ email, password });
      navigate("/tree");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Login failed");
    }
  }

  async function onMagicLink() {
    try {
      await apiClient.requestMagicLink({ email });
      setMessage("Check your email for a sign-in link.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not send link");
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1>myFamiPedia</h1>
      <form onSubmit={onLogin}>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit">Log in</button>
      </form>
      <button onClick={onMagicLink}>Send me a magic link instead</button>
      <p>
        New here? <Link to="/register">Create your family's space</Link>
      </p>
      {message ? <p>{message}</p> : null}
    </div>
  );
}

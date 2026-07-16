import { useState } from "react";
import { apiClient } from "../../lib/apiClient";

interface AskPanelProps {
  personId: string;
}

// Real clip match(es) first, AI synthesis fallback, gap-acknowledgment if
// neither — see docs/api_structure.md.
export function AskPanel({ personId }: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setError(null);
    try {
      const res = await apiClient.request<{ answer: string }>(`/persons/${personId}/ask`, {
        method: "POST",
        body: { question },
      });
      setAnswer(res.answer);
    } catch (err) {
      // Genuinely not implemented server-side yet (needs embeddings + Claude,
      // see apps/api's persons.routes.ts) — surface that plainly rather than
      // leaving an unhandled rejection.
      setError(err instanceof Error ? err.message : "This feature isn't available yet.");
    }
  }

  return (
    <div>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask something…" />
      <button onClick={ask}>Ask</button>
      {answer ? <p>{answer}</p> : null}
      {error ? <p style={{ color: "#b3261e" }}>{error}</p> : null}
    </div>
  );
}

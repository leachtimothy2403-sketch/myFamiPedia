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

  async function ask() {
    const res = await apiClient.request<{ answer: string }>(`/persons/${personId}/ask`, {
      method: "POST",
      body: { question },
    });
    setAnswer(res.answer);
  }

  return (
    <div>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask something…" />
      <button onClick={ask}>Ask</button>
      {answer ? <p>{answer}</p> : null}
    </div>
  );
}

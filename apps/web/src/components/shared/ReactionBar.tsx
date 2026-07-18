import { useState } from "react";
import { apiClient } from "../../lib/apiClient";

interface ReactionBarProps {
  memoryId: string;
}

type ReactionType = "touched_me" | "i_remember_this_too";

// Was fire-and-forget with zero visual feedback either way, so a tap looked
// identical whether it worked or silently failed. The Memory type doesn't
// carry a reaction count/list back from the API, so this is honest
// client-local optimistic confirmation that the tap registered — not a
// true reflection of shared reaction state (someone else's reaction, or a
// past reaction from a previous session, won't show as already-checked).
export function ReactionBar({ memoryId }: ReactionBarProps) {
  const [sent, setSent] = useState<Partial<Record<ReactionType, boolean>>>({});
  const [error, setError] = useState<string | null>(null);

  async function react(reactionType: ReactionType) {
    setError(null);
    try {
      await apiClient.reactToMemory(memoryId, { reactionType });
      setSent((s) => ({ ...s, [reactionType]: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that reaction");
    }
  }

  return (
    <div>
      <button onClick={() => react("touched_me")} disabled={sent.touched_me}>
        {sent.touched_me ? "✓ This touched me" : "This touched me"}
      </button>
      <button onClick={() => react("i_remember_this_too")} disabled={sent.i_remember_this_too}>
        {sent.i_remember_this_too ? "✓ I remember this too" : "I remember this too"}
      </button>
      {error ? <p style={{ color: "#b3261e", fontSize: 12, margin: "4px 0 0" }}>{error}</p> : null}
    </div>
  );
}

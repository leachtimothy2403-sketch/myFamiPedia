import { apiClient } from "../../lib/apiClient";

interface ReactionBarProps {
  memoryId: string;
}

export function ReactionBar({ memoryId }: ReactionBarProps) {
  return (
    <div>
      <button onClick={() => apiClient.reactToMemory(memoryId, { reactionType: "touched_me" })}>
        This touched me
      </button>
      <button onClick={() => apiClient.reactToMemory(memoryId, { reactionType: "i_remember_this_too" })}>
        I remember this too
      </button>
    </div>
  );
}

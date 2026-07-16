import type { Memory } from "@myfamipedia/shared";
import { MemoryCard } from "../shared/MemoryCard";

interface MemoriesFeedProps {
  memories: Memory[];
}

export function MemoriesFeed({ memories }: MemoriesFeedProps) {
  return (
    <div>
      <h2 style={{ fontSize: 16 }}>Memories</h2>
      {memories.length === 0 ? (
        <p style={{ color: "#888", fontSize: 14 }}>No memories shared yet.</p>
      ) : (
        memories.map((m) => <MemoryCard key={m.id} memory={m} />)
      )}
    </div>
  );
}

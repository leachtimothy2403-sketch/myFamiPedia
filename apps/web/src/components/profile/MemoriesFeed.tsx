import type { Memory } from "@myfamipedia/shared";
import { MemoryCard } from "../shared/MemoryCard";

interface MemoriesFeedProps {
  memories: Memory[];
}

export function MemoriesFeed({ memories }: MemoriesFeedProps) {
  return (
    <div>
      {memories.map((m) => (
        <MemoryCard key={m.id} memory={m} />
      ))}
    </div>
  );
}

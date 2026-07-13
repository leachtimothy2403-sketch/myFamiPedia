import type { Memory } from "@myfamipedia/shared";
import { AudioBadge } from "../voice/AudioBadge";
import { ReactionBar } from "./ReactionBar";

interface MemoryCardProps {
  memory: Memory;
}

export function MemoryCard({ memory }: MemoryCardProps) {
  return (
    <article style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, marginBottom: 8 }}>
      {memory.provenanceType === "voice" ? <AudioBadge isRealVoice /> : null}
      {memory.provenanceType === "ai_generated" ? <AudioBadge isRealVoice={false} /> : null}
      <p>{memory.content}</p>
      {memory.provenanceLabel ? <small>{memory.provenanceLabel}</small> : null}
      <ReactionBar memoryId={memory.id} />
    </article>
  );
}

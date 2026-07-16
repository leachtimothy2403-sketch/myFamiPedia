import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../lib/apiClient";

interface AddMemoryFormProps {
  personId: string;
}

// Text-only for now: mediaUrl/photoIds are accepted by the API
// (createMemorySchema) but nothing can populate them without R2 credentials
// being configured (apps/api's r2.service.ts is a deliberate stub) — see
// apps/api's memories.routes.ts POST /memories for the same note.
export function AddMemoryForm({ personId }: AddMemoryFormProps) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) {
      setError("Write something first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.createMemory({
        content: content.trim(),
        eventDate: eventDate || null,
        provenanceType: "text",
        isPrivate,
        personIds: [personId],
        photoIds: [],
      });
      setContent("");
      setEventDate("");
      setIsPrivate(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["person-memories", personId] }),
        queryClient.invalidateQueries({ queryKey: ["person-timeline", personId] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this memory");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: 12,
        marginBottom: 16,
      }}
    >
      <textarea
        placeholder="Share a memory…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        style={{ resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
        <label>
          Date (optional){" "}
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private
        </label>
        <button type="submit" disabled={submitting} style={{ marginLeft: "auto" }}>
          {submitting ? "Saving…" : "Add memory"}
        </button>
      </div>
      {error ? <p style={{ color: "#b3261e", fontSize: 13, margin: 0 }}>{error}</p> : null}
    </form>
  );
}

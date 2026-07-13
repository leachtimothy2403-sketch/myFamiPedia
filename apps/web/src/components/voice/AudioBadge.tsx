interface AudioBadgeProps {
  isRealVoice: boolean; // real recorded audio (teal) vs AI-synthesized (gray)
}

export function AudioBadge({ isRealVoice }: AudioBadgeProps) {
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        background: isRealVoice ? "#0f766e" : "#6b7280",
        color: "white",
      }}
    >
      {isRealVoice ? "Real voice" : "AI voice"}
    </span>
  );
}

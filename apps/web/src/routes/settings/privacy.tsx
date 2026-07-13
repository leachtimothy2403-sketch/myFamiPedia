import { usePrivacyTier } from "../../hooks/usePrivacyTier";

// Placeholder personId — a real build resolves "me" from the auth session context.
export default function PrivacySettingsRoute() {
  const { data, setTier } = usePrivacyTier("me");

  return (
    <div style={{ padding: 24 }}>
      <h1>Privacy tier</h1>
      <p>Current tier: {data?.privacyTier ?? "—"}</p>
      {[1, 2, 3].map((tier) => (
        <button key={tier} onClick={() => setTier(tier as 1 | 2 | 3)}>
          Tier {tier}
        </button>
      ))}
    </div>
  );
}

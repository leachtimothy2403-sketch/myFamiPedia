import { getPersonId } from "../../lib/session";
import { usePrivacyTier } from "../../hooks/usePrivacyTier";
import { useQuestionFrequency, type QuestionFrequency } from "../../hooks/useQuestionFrequency";

const FREQUENCY_LABEL: Record<QuestionFrequency, string> = {
  never: "Never",
  few_days: "Every few days",
  weekly: "Weekly",
  daily: "Daily",
};

// Was hardcoded to usePrivacyTier("me") — "me" isn't a real person id, so
// PATCH /persons/me/privacy-tier always 403'd (personId-vs-"me" check in
// apps/api's collection.routes.ts). Fixed the same way the tree tab was
// fixed last session: decode the real id out of the session instead.
// Question frequency lives on this page too, since it's the same
// self-only "collection" settings pairing mobile's collection/settings.tsx
// describes.
export default function PrivacySettingsRoute() {
  const personId = getPersonId() ?? "";
  const { data, setTier } = usePrivacyTier(personId);
  const { data: freqData, setFrequency } = useQuestionFrequency(personId);

  return (
    <div style={{ padding: 24 }}>
      <h1>Privacy & collection</h1>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16 }}>Privacy tier</h2>
        <p style={{ color: "#666" }}>Current tier: {data?.privacyTier ?? "—"}</p>
        <div style={{ display: "flex", gap: 8 }}>
          {[1, 2, 3].map((tier) => (
            <button key={tier} onClick={() => setTier(tier as 1 | 2 | 3)} disabled={data?.privacyTier === tier}>
              Tier {tier}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 16 }}>Question frequency</h2>
        <p style={{ color: "#666" }}>How often we ask you questions to help build memories.</p>
        <div style={{ display: "flex", gap: 8 }}>
          {(["never", "few_days", "weekly", "daily"] as QuestionFrequency[]).map((freq) => (
            <button key={freq} onClick={() => setFrequency(freq)} disabled={freqData?.questionFrequency === freq}>
              {FREQUENCY_LABEL[freq]}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

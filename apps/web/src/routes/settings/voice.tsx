import { useState } from "react";
import { useVoiceModel } from "../../hooks/useVoiceModel";
import { apiClient } from "../../lib/apiClient";
import { getPersonId } from "../../lib/session";
import { ConsentFlowModal } from "../../components/voice/ConsentFlowModal";

// Was hardcoded to "me" throughout — the consent endpoint explicitly checks
// req.params.id === req.auth.personId and 403s otherwise (apps/api's
// voice.routes.ts), so this page could never actually record consent.
// Fixed the same way the tree tab was fixed last session.
export default function VoiceSettingsRoute() {
  const personId = getPersonId() ?? "";
  const { data } = useVoiceModel(personId);
  const [showConsent, setShowConsent] = useState(false);

  return (
    <div style={{ padding: 24 }}>
      <h1>Voice settings</h1>
      <p>Consent status: {data?.consentStatus ?? "none"}</p>
      <button onClick={() => setShowConsent(true)}>Manage consent</button>
      <button onClick={() => apiClient.request(`/persons/${personId}/voice-model/pause`, { method: "POST" })}>
        Pause
      </button>
      <button onClick={() => apiClient.request(`/persons/${personId}/voice-model/revoke`, { method: "POST" })}>
        Revoke
      </button>
      {showConsent && <ConsentFlowModal personId={personId} onClose={() => setShowConsent(false)} />}
    </div>
  );
}

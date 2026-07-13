import { useState } from "react";
import { useVoiceModel } from "../../hooks/useVoiceModel";
import { apiClient } from "../../lib/apiClient";
import { ConsentFlowModal } from "../../components/voice/ConsentFlowModal";

export default function VoiceSettingsRoute() {
  const { data } = useVoiceModel("me");
  const [showConsent, setShowConsent] = useState(false);

  return (
    <div style={{ padding: 24 }}>
      <h1>Voice settings</h1>
      <p>Consent status: {data?.consentStatus ?? "none"}</p>
      <button onClick={() => setShowConsent(true)}>Manage consent</button>
      <button onClick={() => apiClient.request("/persons/me/voice-model/pause", { method: "POST" })}>Pause</button>
      <button onClick={() => apiClient.request("/persons/me/voice-model/revoke", { method: "POST" })}>Revoke</button>
      {showConsent && <ConsentFlowModal personId="me" onClose={() => setShowConsent(false)} />}
    </div>
  );
}

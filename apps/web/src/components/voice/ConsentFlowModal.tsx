import { useState } from "react";
import { apiClient } from "../../lib/apiClient";

interface ConsentFlowModalProps {
  personId: string;
  onClose: () => void;
}

type Moment = "preview" | "decision" | "confirm";

// Shares copy/logic with the mobile consent screens (app/voice/[personId]/consent.tsx).
// Copy convention: always second person ("Bring your voice to life?"), and this
// modal must never be triggerable for a deceased person.
export function ConsentFlowModal({ personId, onClose }: ConsentFlowModalProps) {
  const [moment, setMoment] = useState<Moment>("preview");

  async function preview() {
    await apiClient.request(`/persons/${personId}/voice-model/preview`, { method: "POST" });
    setMoment("decision");
  }
  async function consent(agree: boolean) {
    await apiClient.request(`/persons/${personId}/voice-model/consent`, {
      method: "POST",
      body: { consented: agree },
    });
    setMoment("confirm");
  }

  return (
    <div role="dialog" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)" }}>
      <div style={{ background: "white", margin: "10% auto", padding: 24, maxWidth: 400 }}>
        {moment === "preview" && (
          <>
            <h2>Hear a 10-second preview of your voice</h2>
            <button onClick={preview}>Play preview</button>
          </>
        )}
        {moment === "decision" && (
          <>
            <h2>Bring your voice to life?</h2>
            <button onClick={() => consent(true)}>Yes, I consent</button>
            <button onClick={() => consent(false)}>Not now</button>
          </>
        )}
        {moment === "confirm" && <p>Thanks — your choice has been recorded.</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

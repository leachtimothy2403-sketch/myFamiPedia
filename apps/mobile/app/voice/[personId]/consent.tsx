import { useState } from "react";
import { View, Text, Button } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

type Moment = "preview" | "decision" | "confirm";

// 4-moment consent flow, modal stack. Copy convention (see voice_pipeline.md):
// always address the subject in second person ("Bring your voice to life?"),
// never third person — and this screen must never render for a deceased
// person, since voice cloning consent is inherently a living-person action.
export default function VoiceConsentScreen() {
  const { personId } = useLocalSearchParams<{ personId: string }>();
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
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      {moment === "preview" && (
        <>
          {/* Was jumping straight to "hear a preview" with no explanation of
              what the feature actually does — added per product feedback. */}
          <Text style={{ fontSize: 15, color: "#444" }}>
            myFamiPedia can generate an AI version of your voice that can read your memories aloud to family, even
            after you're gone. It's built from a short recording and only ever used with your consent.
          </Text>
          <Text style={{ fontSize: 20, fontWeight: "600" }}>Hear a 10-second preview of your voice</Text>
          <Button title="Play preview" onPress={preview} />
        </>
      )}
      {moment === "decision" && (
        <>
          <Text style={{ fontSize: 20, fontWeight: "600" }}>Bring your voice to life?</Text>
          <Button title="Yes, I consent" onPress={() => consent(true)} />
          <Button title="Not now" onPress={() => consent(false)} />
        </>
      )}
      {moment === "confirm" && <Text>Thanks — your choice has been recorded.</Text>}
    </View>
  );
}

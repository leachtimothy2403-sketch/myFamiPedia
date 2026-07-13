import { useState } from "react";
import { View, Text, Button } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { apiClient } from "../../../lib/apiClient";

// Active recording flow, question-by-question or photo-prompted. The
// camera/library button stays live throughout — not just pre-session —
// so a photo can be captured mid-answer without pausing the recording.
// Camera capture must use an in-app camera view (expo-camera), not the OS
// camera app, since a hand-off would suspend the app and cut the audio
// (see docs/voice_pipeline.md for the interview_answer_photos timing).
export default function InterviewSessionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const [recording, setRecording] = useState(false);

  async function capturePhotoMidAnswer() {
    // Opens the in-app camera view; resulting photo is presigned + uploaded,
    // then attached via POST /interview-sessions/:id/answers' photo linkage
    // (staged in interview_answer_photos until the answer is transcribed).
  }

  async function complete() {
    await apiClient.request(`/interview-sessions/${sessionId}/complete`, { method: "POST" });
    router.back();
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>{recording ? "Recording…" : "Ready"}</Text>
      <Button title={recording ? "Stop" : "Start answering"} onPress={() => setRecording((r) => !r)} />
      <Button title="Take or add a photo" onPress={capturePhotoMidAnswer} />
      <Button title="Finish session" onPress={complete} />
    </View>
  );
}

import { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useAudioRecorder, useAudioRecorderState, RecordingPresets, AudioModule, setAudioModeAsync } from "expo-audio";
import { apiClient } from "../../../lib/apiClient";

// Real recording, replacing the earlier stub that just toggled a label with
// no actual audio capture. Flow: record locally with expo-audio -> on stop,
// upload the file to R2 via the new POST /uploads/presign (presigned PUT,
// bytes never pass through Express) -> attach the resulting r2Key to this
// question via POST /interview-sessions/:id/answers -> repeat for more
// questions -> "Finish session" completes the session, which enqueues one
// transcription job per answer (already implemented, was just never
// reachable because nothing upstream produced a real audioR2Key).
//
// questionId/questionText are optional — the "Share a memory" and "Start
// with a picture" starting points ((tabs)/share-story.tsx) have no specific
// question attached, which migration 021 made possible server-side.
export default function InterviewSessionScreen() {
  const { sessionId, personId, questionId, questionText } = useLocalSearchParams<{
    sessionId: string;
    personId?: string;
    questionId?: string;
    questionText?: string;
  }>();

  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);
  const [uploading, setUploading] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Whether this is a Q&A session at all (vs. "Share a memory"/"Start with a
  // picture", which never had a question to begin with) is fixed by how the
  // session started — captured once so it doesn't change as `question`
  // itself advances to the next one. Once a Q&A session's questions run out,
  // qaExhausted flips and the recording controls hide (nothing left to answer).
  const [isQAFlow] = useState(Boolean(questionId));
  const [question, setQuestion] = useState<{ id?: string; text?: string }>({
    id: questionId,
    text: questionText,
  });
  const [qaExhausted, setQaExhausted] = useState(false);

  async function startRecording() {
    setError(null);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission is required to record an answer.");
        return;
      }
      // iOS refuses to record until the audio session is explicitly put into
      // a recording-capable mode — this was missing, hence
      // "RecordingDisabledException: Recording not allowed on iOS." Once that
      // was added, iOS raised a second, more specific constraint:
      // allowsRecording: true is an "impossible audio mode" unless
      // playsInSilentMode is also true — iOS ties recording capability to
      // the silent-mode-override audio category, they can't be split.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start recording");
    }
  }

  async function stopAndSaveAnswer() {
    setError(null);
    try {
      await audioRecorder.stop();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't stop recording");
      return;
    }
    const uri = audioRecorder.uri;
    if (!uri) {
      setError("Recording didn't produce a file — try again.");
      return;
    }

    setUploading(true);
    try {
      const { uploadUrl, r2Key } = await apiClient.presignUpload({ contentType: "audio/m4a", context: "voice" });
      const fileResponse = await fetch(uri);
      const blob = await fileResponse.blob();
      const putResponse = await fetch(uploadUrl, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": "audio/m4a" },
      });
      if (!putResponse.ok) throw new Error("Upload to storage failed — try again.");

      await apiClient.request(`/interview-sessions/${sessionId}/answers`, {
        method: "POST",
        body: { questionId: question.id ?? undefined, audioR2Key: r2Key },
      });
      setSavedCount((c) => c + 1);
      if (isQAFlow) await advanceToNextQuestion();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this answer");
    } finally {
      setUploading(false);
    }
  }

  // After each answer in a Q&A session, pull the next question straight
  // away — per feedback, sitting on the same question after "stop & save"
  // read as broken rather than "ready for the next one". Reuses the same
  // GET /interview-questions/next endpoint as the initial tap on the Share
  // tab, so it still walks the curated bank in order before ever generating
  // a follow-up, exactly like starting a fresh session would.
  async function advanceToNextQuestion() {
    if (!personId) return;
    try {
      const next = await apiClient.request<{ id: string; text: string } | undefined>(
        `/interview-questions/next?personId=${personId}`
      );
      if (next) {
        setQuestion({ id: next.id, text: next.text });
      } else {
        setQaExhausted(true);
      }
    } catch (err) {
      // Don't block the flow on this — the answer already saved fine.
      // Worst case they tap "Finish session" one question early.
      setError(err instanceof Error ? err.message : "Couldn't load the next question.");
    }
  }

  async function capturePhotoMidAnswer() {
    // Opens the in-app camera view; resulting photo is presigned + uploaded,
    // then attached via POST /interview-sessions/:id/answers' photo linkage
    // (staged in interview_answer_photos until the answer is transcribed).
    // Not wired yet — separate scope from the audio recording fix above.
  }

  async function complete() {
    setError(null);
    setFinishing(true);
    try {
      await apiClient.request(`/interview-sessions/${sessionId}/complete`, { method: "POST" });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't finish this session");
      setFinishing(false);
    }
  }

  const busy = uploading || finishing;

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      {question.text ? <Text style={{ fontSize: 18, fontWeight: "600" }}>{question.text}</Text> : null}
      {qaExhausted ? (
        <Text style={{ color: "#666" }}>That's everything for now — thanks for sharing! Tap "Finish session" below.</Text>
      ) : (
        <Text style={{ fontSize: 20, fontWeight: "600" }}>
          {recorderState.isRecording ? "Recording…" : uploading ? "Saving…" : "Ready"}
        </Text>
      )}

      {qaExhausted ? null : recorderState.isRecording ? (
        <TouchableOpacity
          onPress={stopAndSaveAnswer}
          style={{ backgroundColor: "#b3261e", padding: 14, borderRadius: 8 }}
        >
          <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>Stop &amp; save answer</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          onPress={startRecording}
          disabled={busy}
          style={{ backgroundColor: "#1a73e8", padding: 14, borderRadius: 8, opacity: busy ? 0.6 : 1 }}
        >
          <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>Start answering</Text>
        </TouchableOpacity>
      )}

      {uploading ? <ActivityIndicator /> : null}
      {savedCount > 0 ? (
        <Text style={{ color: "#0f766e" }}>
          {savedCount} answer{savedCount > 1 ? "s" : ""} saved this session
        </Text>
      ) : null}

      <TouchableOpacity onPress={capturePhotoMidAnswer} disabled={busy}>
        <Text style={{ color: busy ? "#999" : "#1a73e8" }}>Take or add a photo</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={complete} disabled={busy}>
        <Text style={{ color: busy ? "#999" : "#1a73e8", fontWeight: "600" }}>
          {finishing ? "Finishing…" : "Finish session"}
        </Text>
      </TouchableOpacity>

      {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

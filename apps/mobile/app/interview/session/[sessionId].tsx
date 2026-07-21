import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from "react-native";
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

  // 2026-07-21/22 — the clarifying follow-up (migration 029). Set right
  // after an answer saves, when the server offers one; recording controls
  // and the next question both stay hidden until this resolves (answered or
  // skipped), same "one thing at a time" principle as the rest of this
  // screen. Text input rather than voice — a clarification is usually one
  // short fact (a name, a date), and typing it is a lot less friction than
  // re-recording for one word; the API accepts either.
  const [clarification, setClarification] = useState<{ answerId: string; question: string } | null>(null);
  const [clarificationText, setClarificationText] = useState("");
  const [clarifying, setClarifying] = useState(false);

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

      const saved = await apiClient.request<{ id: string; clarifyingQuestion: string | null }>(
        `/interview-sessions/${sessionId}/answers`,
        {
          method: "POST",
          body: { questionId: question.id ?? undefined, audioR2Key: r2Key },
        }
      );
      setSavedCount((c) => c + 1);
      if (saved.clarifyingQuestion) {
        // Hold off advancing until this resolves — see resolveClarification.
        setClarification({ answerId: saved.id, question: saved.clarifyingQuestion });
      } else if (isQAFlow) {
        await advanceToNextQuestion();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this answer");
    } finally {
      setUploading(false);
    }
  }

  // Answering ("submit") or skipping both resolve the same way afterward:
  // clear the clarification state and continue the session exactly as if it
  // had never come up (advance to the next question in a Q&A flow, or just
  // sit at "Ready" for open-ended/photo-prompted). Skip is deliberately one
  // tap, no confirmation, no explanation required — it has to be at least as
  // easy as answering.
  async function resolveClarification(action: "answer" | "skip") {
    if (!clarification) return;
    setClarifying(true);
    setError(null);
    try {
      if (action === "answer") {
        if (!clarificationText.trim()) {
          setError("Type an answer, or tap Skip.");
          return;
        }
        await apiClient.request(`/interview-sessions/${sessionId}/answers`, {
          method: "POST",
          body: { content: clarificationText.trim(), clarifiesAnswerId: clarification.answerId },
        });
      } else {
        await apiClient.request(`/interview-sessions/${sessionId}/answers/${clarification.answerId}/skip-clarification`, {
          method: "POST",
        });
      }
      setClarification(null);
      setClarificationText("");
      if (isQAFlow) await advanceToNextQuestion();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that — try again.");
    } finally {
      setClarifying(false);
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

  if (clarification) {
    return (
      <View style={{ flex: 1, padding: 16, gap: 16 }}>
        <View style={{ backgroundColor: "#fafafa", borderRadius: 12, padding: 16, gap: 12 }}>
          <Text style={{ fontSize: 13, color: "#666", fontWeight: "600" }}>QUICK ONE</Text>
          <Text style={{ fontSize: 17, fontWeight: "600" }}>{clarification.question}</Text>
          <TextInput
            placeholder="Type your answer…"
            value={clarificationText}
            onChangeText={setClarificationText}
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, fontSize: 16, backgroundColor: "white" }}
          />
        </View>

        {/* Equal visual weight on purpose — skipping has to be at least as
            easy as answering, never a smaller or guiltier-looking option. */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          <TouchableOpacity
            onPress={() => resolveClarification("skip")}
            disabled={clarifying}
            style={{ flex: 1, backgroundColor: "#f0f0f0", paddingVertical: 14, borderRadius: 8, opacity: clarifying ? 0.6 : 1 }}
          >
            <Text style={{ fontWeight: "600", textAlign: "center" }}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => resolveClarification("answer")}
            disabled={clarifying}
            style={{ flex: 1, backgroundColor: "#1a73e8", paddingVertical: 14, borderRadius: 8, opacity: clarifying ? 0.6 : 1 }}
          >
            <Text style={{ color: "white", fontWeight: "600", textAlign: "center" }}>{clarifying ? "Saving…" : "Answer"}</Text>
          </TouchableOpacity>
        </View>

        {error ? <Text style={{ color: "#b3261e", fontSize: 13 }}>{error}</Text> : null}
      </View>
    );
  }

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

// Speech-to-text for interview answers — OpenAI's Whisper REST endpoint is
// plain HTTP (Bearer auth, multipart upload), so unlike vision.service.ts
// this is a real, working implementation, not just an interface. It only
// needs OPENAI_API_KEY set; no SDK, no request signing, Node 20's built-in
// fetch/FormData/Blob are enough. See docs/voice_pipeline.md section 1.
import { env } from "../config/env";

export interface TranscriptionService {
  transcribe(audioBytes: Buffer, filename: string): Promise<string>;
}

class OpenAiWhisperService implements TranscriptionService {
  async transcribe(audioBytes: Buffer, filename: string): Promise<string> {
    if (!env.openaiApiKey) {
      throw new Error(
        "TranscriptionService.transcribe is not configured — set OPENAI_API_KEY. See docs/voice_pipeline.md section 1."
      );
    }
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([new Uint8Array(audioBytes)]), filename);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openaiApiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Whisper transcription request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { text: string };
    return data.text;
  }
}

export const transcriptionService: TranscriptionService = new OpenAiWhisperService();

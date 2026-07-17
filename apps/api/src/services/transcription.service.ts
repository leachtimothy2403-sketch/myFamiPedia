// Speech-to-text for interview answers — ElevenLabs' Speech-to-Text REST
// endpoint (Scribe v2), plain HTTP (xi-api-key header, multipart upload), no
// SDK needed, same house style as before. Switched from OpenAI Whisper: this
// project already needs an ElevenLabs key for voice cloning
// (voiceClone.service.ts), so this removes OPENAI_API_KEY as a dependency
// entirely rather than juggling two providers. Scribe v2 (not v1, which
// ElevenLabs has since superseded) benchmarks at or above Whisper v3 on
// accuracy — see docs/voice_pipeline.md section 1 for the comparison notes
// and why this was chosen over gpt-4o-transcribe.
import { env } from "../config/env";

export interface TranscriptionService {
  transcribe(audioBytes: Buffer, filename: string): Promise<string>;
}

interface ElevenLabsSpeechToTextResponse {
  text: string;
  language_code?: string;
  language_probability?: number;
}

class ElevenLabsScribeService implements TranscriptionService {
  async transcribe(audioBytes: Buffer, filename: string): Promise<string> {
    if (!env.elevenlabsApiKey) {
      throw new Error(
        "TranscriptionService.transcribe is not configured — set ELEVENLABS_API_KEY. See docs/voice_pipeline.md section 1."
      );
    }
    const form = new FormData();
    form.append("model_id", "scribe_v2");
    form.append("file", new Blob([new Uint8Array(audioBytes)]), filename);

    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": env.elevenlabsApiKey },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs speech-to-text request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as ElevenLabsSpeechToTextResponse;
    return data.text;
  }
}

export const transcriptionService: TranscriptionService = new ElevenLabsScribeService();

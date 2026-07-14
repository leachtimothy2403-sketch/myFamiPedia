// ElevenLabs voice cloning — also a plain REST API (xi-api-key header), so
// this is a real implementation gated on ELEVENLABS_API_KEY, following the
// same pattern as transcription.service.ts. See docs/voice_pipeline.md.
import { env } from "../config/env";

export interface VoiceCloneService {
  /** Moment 1 (preview): create/refresh an instant-clone model from whatever samples we have so far. */
  createOrUpdateInstantModel(params: {
    modelId: string | null; // existing elevenlabs_model_id, if any — re-adds samples to the same voice
    name: string;
    sampleAudio: { buffer: Buffer; filename: string }[];
  }): Promise<{ modelId: string }>;
  /** Synthesizes a short preview clip so the person can hear their own cloned voice before consenting. */
  synthesizePreviewClip(modelId: string, text: string): Promise<Buffer>;
  /** Permanent revoke — deletes the model server-side. */
  deleteModel(modelId: string): Promise<void>;
}

const BASE_URL = "https://api.elevenlabs.io/v1";

class ElevenLabsService implements VoiceCloneService {
  private headers() {
    if (!env.elevenlabsApiKey) {
      throw new Error(
        "VoiceCloneService is not configured — set ELEVENLABS_API_KEY. See docs/voice_pipeline.md."
      );
    }
    return { "xi-api-key": env.elevenlabsApiKey };
  }

  async createOrUpdateInstantModel(params: {
    modelId: string | null;
    name: string;
    sampleAudio: { buffer: Buffer; filename: string }[];
  }): Promise<{ modelId: string }> {
    const headers = this.headers();
    const form = new FormData();
    form.append("name", params.name);
    for (const sample of params.sampleAudio) {
      form.append("files", new Blob([new Uint8Array(sample.buffer)]), sample.filename);
    }

    const isUpdate = Boolean(params.modelId);
    const url = isUpdate ? `${BASE_URL}/voices/${params.modelId}/edit` : `${BASE_URL}/voices/add`;
    const res = await fetch(url, { method: "POST", headers, body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs ${isUpdate ? "edit" : "add"} voice request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { voice_id?: string };
    return { modelId: data.voice_id ?? params.modelId! };
  }

  async synthesizePreviewClip(modelId: string, text: string): Promise<Buffer> {
    const headers = this.headers();
    const res = await fetch(`${BASE_URL}/text-to-speech/${modelId}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs text-to-speech request failed (${res.status}): ${body}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async deleteModel(modelId: string): Promise<void> {
    const headers = this.headers();
    const res = await fetch(`${BASE_URL}/voices/${modelId}`, { method: "DELETE", headers });
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs delete voice request failed (${res.status}): ${body}`);
    }
  }
}

export const voiceCloneService: VoiceCloneService = new ElevenLabsService();

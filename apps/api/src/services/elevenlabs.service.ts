// ElevenLabs — voice cloning (instant/professional) + TTS. See docs/voice_pipeline.md.
// Copy convention: any text rendered from this service's output must address the
// subject in second person ("your voice"), never third person by name.
export async function createInstantClone(_personId: string, _audioR2Keys: string[]): Promise<{ modelId: string }> {
  throw new Error("Not implemented");
}

export async function synthesize(_modelId: string, _text: string): Promise<{ audioUrl: string }> {
  throw new Error("Not implemented");
}

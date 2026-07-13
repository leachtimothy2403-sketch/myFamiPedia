// OpenAI Whisper — see docs/voice_pipeline.md section 1. $0.006/min, billed per Q_TRANS job.
export async function transcribe(_audioR2Key: string): Promise<{ transcript: string }> {
  throw new Error("Not implemented — call OpenAI's audio transcription endpoint");
}

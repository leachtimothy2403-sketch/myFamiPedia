// Anthropic Claude — question generation, memory summarization, AI-drafted Ask
// feature answers, "who she was" profile summaries. Always label output as
// AI-generated in the response payload; the client is responsible for the
// visible badge, but the API should never omit the flag.
export async function generateProfileSummary(_personId: string): Promise<{ summary: string }> {
  throw new Error("Not implemented");
}

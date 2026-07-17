// Anthropic Claude — question generation, memory summarization, AI-drafted Ask
// feature answers, "who she was" profile summaries. Always label output as
// AI-generated in the response payload; the client is responsible for the
// visible badge, but the API should never omit the flag.
//
// Plain HTTP against the Messages API, same house style as
// transcription.service.ts (no SDK dependency needed for one endpoint).
import { env } from "../config/env";

export async function generateProfileSummary(_personId: string): Promise<{ summary: string }> {
  throw new Error("Not implemented");
}

export interface PriorQA {
  question: string;
  answer: string;
}

// Adaptive Q&A follow-up (docs/section2_pipeline.md section 4): once the
// curated question bank (migration 008) is exhausted for a person, the next
// question should dig into something they've actually talked about instead
// of repeating the same generic list for everyone forever.
//
// Two rounds of product feedback shaped this: first, an "ease in gradually"
// request (start broad, only get specific after a couple of generated
// follow-ups) — since superseded by the opposite ask, that follow-ups should
// always dig into one specific interesting topic right away. Second, and
// still in force: build only from this person's actual life-story Q&A
// (priorQAs — curated + previously generated), not the broader `memories`
// table. That table mixes in freeform "share a memory"/photo-prompted
// content that has nothing to do with the structured interview, which is
// what led a follow-up to fixate on an unrelated Tour de France anecdote.
export async function generateFollowUpQuestion(input: { personName: string; priorQAs: PriorQA[] }): Promise<string> {
  if (!env.anthropicApiKey) {
    throw new Error(
      "generateFollowUpQuestion is not configured — set ANTHROPIC_API_KEY. See docs/section2_pipeline.md section 4."
    );
  }

  const context = input.priorQAs.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n");

  const prompt = `You are helping build a family history archive. Below is ${input.personName}'s life-story interview so far — questions asked and their answers.

${context}

Pick ONE specific topic, person, place, or event from the answers above that seems genuinely interesting and worth exploring further, and write ONE warm follow-up interview question that digs deeper into it. Do not repeat a question that's effectively already been asked. Keep it conversational, one sentence, second person ("you"/"your"). Respond with only the question text — no preamble, no quotation marks, no numbering.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude follow-up question request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((block) => block.type === "text")?.text?.trim();
  if (!text) throw new Error("Claude returned no follow-up question text");
  return text.replace(/^["']|["']$/g, "");
}

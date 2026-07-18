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
  lifePhase?: string;
}

// Adaptive Q&A follow-up (docs/section2_pipeline.md section 4): once the
// curated question bank (migration 008) is exhausted for a person, the next
// question should build on something they've actually talked about instead
// of repeating the same generic list for everyone forever.
//
// Three rounds of product feedback shaped this, each superseding the last:
// (1) "ease in gradually" (start broad, only get specific later) — dropped;
// (2) "always dig into one specific interesting topic right away" — this is
// what led a follow-up to fixate on a narrow Tour de France anecdote and
// keep circling back to it across multiple follow-ups; (3) current: stay at
// the same general-life-question register as the curated bank (childhood,
// education, work, relationships, family, values, legacy) and use the
// answers to build a FULLER PICTURE of the whole life story — extending
// into thin/unexplored areas or a natural next general question — rather
// than drilling into one specific memory or anecdote. Still built only from
// this person's actual life-story Q&A (priorQAs — curated + previously
// generated), never the broader `memories` table, which mixes in unrelated
// freeform "share a memory"/photo content.
export async function generateFollowUpQuestion(input: { personName: string; priorQAs: PriorQA[] }): Promise<string> {
  if (!env.anthropicApiKey) {
    throw new Error(
      "generateFollowUpQuestion is not configured — set ANTHROPIC_API_KEY. See docs/section2_pipeline.md section 4."
    );
  }

  const context = input.priorQAs
    .map((qa) => `Q (${qa.lifePhase ?? "general"}): ${qa.question}\nA: ${qa.answer}`)
    .join("\n\n");

  const prompt = `You are helping build a family history archive through a structured life-story interview. Below is ${input.personName}'s interview so far — general life questions spanning categories like childhood, education, work, relationships, family, values, and legacy, with the life phase noted alongside each one, and their answers.

${context}

The curated set of general life questions has been fully answered. Write ONE follow-up question that stays in that same register — a general life question, not a drill into one narrow specific memory, anecdote, or detail — that helps build a fuller, more complete picture of their overall life story. Prefer extending into a life area that's thin or unexplored so far, or a natural next general question suggested by what they've shared, over zooming into one specific event they mentioned. Do not repeat a question that's effectively already been asked. Keep it conversational, one sentence, second person ("you"/"your"). Respond with only the question text — no preamble, no quotation marks, no numbering.`;

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

export interface PhotoClassificationResult {
  isCandidateWorthy: boolean;
  suggestedCaption: string | null;
}

// Stage 2 of scene classification (docs/photo_pipeline_beta_architecture.md
// section 5) — only called for photos that already passed stage 1's cheap
// Rekognition DetectLabels triage (sceneLabels.service.ts). Confirms or
// vetoes stage 1's guess by actually looking at the full image, and writes
// the caption suggestion text. Haiku, not Sonnet — closer to a
// classification task than deep reasoning, and per-image cost matters here
// since this still runs on every triage-passed photo, not a handful.
export async function classifyPhotoScene(
  imageBytes: Buffer,
  labels: { label: string; confidence: number }[]
): Promise<PhotoClassificationResult> {
  if (!env.anthropicApiKey) {
    throw new Error(
      "classifyPhotoScene is not configured — set ANTHROPIC_API_KEY. See docs/photo_pipeline_beta_architecture.md section 5."
    );
  }

  const labelList = labels.map((l) => `${l.label} (${l.confidence.toFixed(0)}%)`).join(", ") || "none";
  const prompt = `You are helping decide whether a family photo is worth proactively suggesting as a candidate memory in a family archive app. An automated label detector flagged this photo with: ${labelList}.

Look at the actual photo. Decide: is this genuinely a distinctive family moment worth surfacing (a real celebration, milestone, or gathering — not an ordinary or ambiguous photo the label detector over-matched)? Be conservative — when in doubt, say no; a false negative just means the person adds it manually later, a false positive is an unwanted interruption. Be careful of tone: do not guess a celebratory occasion if the photo could plausibly be a memorial, injury, or other somber moment — in that case isCandidateWorthy should be false regardless of the labels.

If yes, write ONE short, warm, natural-sounding caption suggestion (under 12 words, no hashtags, no exclamation-point-per-sentence enthusiasm) describing what's likely happening, that a person could accept as-is or edit.

Respond with ONLY a JSON object, no other text, no markdown code fences: {"isCandidateWorthy": boolean, "suggestedCaption": string or null}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBytes.toString("base64") } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude scene-classification request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((block) => block.type === "text")?.text?.trim();
  if (!text) throw new Error("Claude returned no scene-classification text");

  let parsed: { isCandidateWorthy?: boolean; suggestedCaption?: string | null };
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error(`Claude scene-classification response was not valid JSON: ${text}`);
  }
  return { isCandidateWorthy: Boolean(parsed.isCandidateWorthy), suggestedCaption: parsed.suggestedCaption ?? null };
}

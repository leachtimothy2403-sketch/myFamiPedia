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

// The eighteen life-story categories the curated bank is organized around
// (apps/api/src/db/curatedQuestions.js — the shared source of truth with
// the seed/migration that actually populate interview_questions). Not
// re-imported from that .js file directly to keep this a plain, isolated
// .ts module with no runtime dependency on db/ — the two lists are grown
// together deliberately, not derived from one another.
export const INTERVIEW_CATEGORIES = [
  "origins",
  "childhood",
  "education",
  "coming_of_age",
  "romance",
  "partnership",
  "parenthood",
  "siblings_family",
  "friendship",
  "work",
  "money",
  "health_hardship",
  "historical_context",
  "community_faith",
  "passions",
  "values",
  "turning_points",
  "legacy",
] as const;
export type InterviewCategory = (typeof INTERVIEW_CATEGORIES)[number];

function isInterviewCategory(value: string): value is InterviewCategory {
  return (INTERVIEW_CATEGORIES as readonly string[]).includes(value);
}

// Deterministic, model-independent fallback for when Claude's response
// doesn't parse into one of the eighteen known categories — picks whichever
// known category appears least often in the recent history, so a malformed
// response still nudges toward the same "spread across categories" goal
// rather than defaulting to some arbitrary fixed category every time.
function leastRecentlyUsedCategory(recentCategories: string[]): InterviewCategory {
  const counts = new Map<InterviewCategory, number>(INTERVIEW_CATEGORIES.map((c) => [c, 0]));
  for (const c of recentCategories) {
    if (isInterviewCategory(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

export interface GeneratedFollowUp {
  question: string;
  lifePhase: InterviewCategory;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 2026-07-19 fix — a real interview hit "Claude returned no follow-up
// question text" mid-run, taking down the whole GET /interview-questions/next
// request with a 500 (docs/handover_2026-07-19-qa-persona-eval.md — first
// found in the eval script's own Claude calls, then in this production
// function too). A single transient empty/malformed response, or a
// retryable 5xx, from the Anthropic API shouldn't fail an interview request
// outright when a short retry is cheap and this call isn't on any hot path.
// Kept local to this file rather than shared with the eval script's own
// retry logic (scripts/personaQaEval/run.ts) — same idea, but that script
// is intentionally a standalone, dependency-light tool with its own copy.
async function callAnthropic(prompt: string, maxTokens: number): Promise<string> {
  const maxAttempts = 3;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Claude request failed (${res.status}): ${body}`);
      }
      const data = (await res.json()) as { content: { type: string; text?: string }[]; stop_reason?: string };
      const text = data.content?.find((block) => block.type === "text")?.text?.trim();
      if (!text) {
        throw new Error(`Claude returned no text content (stop_reason: ${data.stop_reason ?? "unknown"})`);
      }
      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) await sleep(attempt * 500);
    }
  }
  throw lastError ?? new Error("Claude request failed for an unknown reason");
}

// Adaptive Q&A follow-up (docs/section2_pipeline.md section 4): once the
// curated question bank (migration 008) is exhausted for a person, the next
// question should build on something they've actually talked about instead
// of repeating the same generic list for everyone forever.
//
// Four rounds of product feedback shaped this, each superseding the last:
// (1) "ease in gradually" (start broad, only get specific later) — dropped;
// (2) "always dig into one specific interesting topic right away" — this is
// what led a follow-up to fixate on a narrow Tour de France anecdote and
// keep circling back to it across multiple follow-ups; (3) stay at the same
// general-life-question register as the curated bank and use the answers to
// build a FULLER PICTURE of the whole life story — extending into
// thin/unexplored areas — rather than drilling into one specific memory;
// (4) 2026-07-19, this round — spread deliberately across the eighteen
// curated categories rather than letting whatever's most recently discussed
// dominate. Still built only from this person's actual life-story Q&A
// (priorQAs — curated + previously generated), never the broader `memories`
// table, which mixes in unrelated freeform "share a memory"/photo content.
//
// 2026-07-19 fix — repeated/near-duplicate follow-ups on long interviews.
// The persona eval (docs/handover_2026-07-19-qa-persona-eval.md) surfaced
// this on a real 40-question run: several follow-ups substantively re-asked
// something already covered (marriage lessons asked 3 times, "hardest season
// of life" asked twice with near-identical answers expected). Root cause —
// `priorQAs` (still used below for detailed, answer-level context) was
// always capped to the most recent 8 answers by the caller
// (interviews.routes.ts), for good reason: passing every full answer ever
// given would grow the prompt unboundedly on a long interview. But that same
// cap meant the "do not repeat a question that's effectively already been
// asked" instruction only had 8 questions' worth of memory — anything asked
// earlier scrolled out of view entirely, including from the curated bank
// itself, and the model had no way to know it was retreading old ground.
// `priorQuestionTexts` fixes this cheaply: the full list of every question
// ever asked this person, text + life phase only, no answers — cheap enough
// to include in full even on a long interview, and enough on its own to
// reliably avoid duplicates even without the detailed answer context.
//
// 2026-07-19 fix — category spread. Fixing repeats didn't fix a related but
// distinct complaint: a run could still spend many follow-ups in a row
// circling the same life category (e.g. marriage/partnership) even without
// asking the literal same question twice. Every generated question up to
// this point was also stored with a placeholder life_phase of "generated" —
// meaningless for tracking which of the eighteen real categories it actually
// belonged to. This function now returns the category it picked alongside
// the question text (GeneratedFollowUp, not a bare string), given the recent
// category sequence, with an explicit "don't stay in one category for 3+
// questions in a row" rule — Tim's direction after reviewing eval output.
export async function generateFollowUpQuestion(input: {
  personName: string;
  priorQAs: PriorQA[];
  priorQuestionTexts: { question: string; lifePhase?: string }[];
  recentCategories: string[]; // chronological, oldest first, most recent last
}): Promise<GeneratedFollowUp> {
  if (!env.anthropicApiKey) {
    throw new Error(
      "generateFollowUpQuestion is not configured — set ANTHROPIC_API_KEY. See docs/section2_pipeline.md section 4."
    );
  }

  const context = input.priorQAs
    .map((qa) => `Q (${qa.lifePhase ?? "general"}): ${qa.question}\nA: ${qa.answer}`)
    .join("\n\n");

  const askedList = input.priorQuestionTexts
    .map((q, i) => `${i + 1}. (${q.lifePhase ?? "general"}) ${q.question}`)
    .join("\n");

  const categoryList = INTERVIEW_CATEGORIES.join(", ");
  const recentCategoriesText = input.recentCategories.length ? input.recentCategories.join(" -> ") : "(none yet)";

  const prompt = `You are helping build a family history archive through a structured life-story interview. Below is ${input.personName}'s interview so far — general life questions spanning categories like childhood, education, work, relationships, family, values, and legacy, with the life phase noted alongside each one, and their answers.

${context}

Every question asked so far in this interview, in order (for reference only — some are from earlier in the conversation than the detailed answers above, which only show the most recent ones):

${askedList}

The eighteen life-story categories this interview draws from: ${categoryList}.

The categories of the most recent questions, in order (oldest to newest): ${recentCategoriesText}.

The curated set of general life questions has been fully answered. Write ONE follow-up question that stays in that same register — a general life question, not a drill into one narrow specific memory, anecdote, or detail — that helps build a fuller, more complete picture of their overall life story. Prefer extending into a life area that's thin or unexplored so far, or a natural next general question suggested by what they've shared, over zooming into one specific event they mentioned. Check your draft question against the FULL list of questions already asked above, not just the detailed answers — do not ask anything substantively the same as a question already on that list, even if worded differently or framed from a new angle.

Also spread across categories deliberately: don't stay in one category too long. If the same category appears for three or more of the most recent questions in a row, you MUST pick a different one this time, even if that category still has more to explore — there will be other chances to come back to it later.

Keep it conversational, one sentence, second person ("you"/"your"). Respond in EXACTLY this two-line format, nothing else, no preamble:
CATEGORY: <one of the eighteen category keys above, exactly as written, lowercase with underscores>
QUESTION: <the question text — no quotation marks, no numbering>`;

  const text = await callAnthropic(prompt, 250);

  const categoryMatch = text.match(/CATEGORY:\s*(\S+)/i);
  const questionMatch = text.match(/QUESTION:\s*(.+)/is);

  const rawCategory = categoryMatch?.[1]?.trim().toLowerCase();
  const lifePhase = rawCategory && isInterviewCategory(rawCategory) ? rawCategory : leastRecentlyUsedCategory(input.recentCategories);

  // Falls back to the whole response as the question text if the two-line
  // format didn't parse at all — better than throwing away an otherwise
  // fine question over a formatting slip.
  const question = (questionMatch?.[1]?.trim() ?? text).replace(/^["']|["']$/g, "");

  return { question, lifePhase };
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

// Anthropic Claude — question generation, memory summarization, AI-drafted Ask
// feature answers, "who she was" profile summaries. Always label output as
// AI-generated in the response payload; the client is responsible for the
// visible badge, but the API should never omit the flag.
//
// Plain HTTP against the Messages API, same house style as
// transcription.service.ts (no SDK dependency needed for one endpoint).
import { env } from "../config/env";

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

// 2026-07-19 fix — category balance over the WHOLE interview, not just a
// short recent window. The persona eval's first 90-question run (see
// docs/handover_2026-07-19-qa-persona-eval.md's "second-order fix" section)
// scored well overall (91/100) but its grading pass flagged real pacing
// problems the existing "3-in-a-row" streak rule structurally can't catch:
// community_faith and passions were each picked 4 of the 45 follow-up slots,
// turning_points also 4, while parenthood/partnership/childhood only got 1
// follow-up each — never 3-in-a-row at any point, so the streak rule never
// fired, but badly unbalanced over the interview as a whole (Q40 and Q69
// were both community_faith asking essentially the same "where did you
// belong" question 29 turns apart; Q41/51/62/87 all mined "things you do for
// yourself" repeatedly).
//
// 2026-07-19 fourth fix, same day — this used to tally straight from
// priorQuestionTexts (every question ever asked, appended forever — see the
// removed docstring below on generateFollowUpQuestion for why that got
// replaced with biographySections). Only ever used each entry's lifePhase,
// never its text, so the replacement is just as accurate a tally and a lot
// cheaper to carry around: biographySections already has one row per
// category with its own running count, no scanning needed.
function tallyCategoryCounts(biographySections: { lifePhase: string; askedQuestionStems: string[] }[]): Map<InterviewCategory, number> {
  const counts = new Map<InterviewCategory, number>(INTERVIEW_CATEGORIES.map((c) => [c, 0]));
  for (const s of biographySections) {
    if (isInterviewCategory(s.lifePhase)) counts.set(s.lifePhase, s.askedQuestionStems.length);
  }
  return counts;
}

// Deterministic, model-independent fallback for when Claude's response
// doesn't parse into one of the eighteen known categories — picks whichever
// known category has been used least often across the WHOLE interview (see
// tallyCategoryCounts above), so a malformed response still nudges toward
// the same "spread across categories" goal rather than defaulting to some
// arbitrary fixed category every time. Deliberately based on the full-history
// tally rather than just the recent-window streak (recentCategories) — a
// category can be underused overall without ever appearing in the last few
// questions, and the fallback should reach for that gap first.
function leastUsedCategory(categoryCounts: Map<InterviewCategory, number>): InterviewCategory {
  return [...categoryCounts.entries()].sort((a, b) => a[1] - b[1])[0][0];
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
//
// 2026-07-19 second fix, same day — the plain retry above wasn't enough. A
// deep real interview (question 50, by which point priorQuestionTexts and
// the duplicate/category-avoidance instructions have grown substantially)
// hit the same "no text content" failure with stop_reason: max_tokens —
// meaning the model got cut off before ever emitting a text block, not a
// random glitch. Retrying with the SAME token budget three times just hit
// the identical wall three times, wasting all the retry attempts on a
// failure that was never going to resolve itself. Now: when a failure is
// specifically a max_tokens cutoff with no text produced, the next attempt
// doubles the budget (capped at 2000) instead of just waiting and repeating
// verbatim — genuinely transient failures (5xx, an empty response for no
// discernible reason) still just get a plain backoff-and-retry.
//
// 2026-07-19 third fix, same day — a live 90-question persona eval run
// (docs/handover_2026-07-19-qa-persona-eval.md, prompted by the category-
// pacing fix in generateFollowUpQuestion just below) hit this same wall
// again at question 65, but this time the escalation ladder itself wasn't
// enough: 500 -> 1000 -> 2000 all cut off with zero text emitted, exhausting
// every attempt at maxAttempts=3. By that point in a long interview the
// category-balance instructions have real teeth (most categories already at
// or past the "3 is a soft ceiling" line), which appears to make the
// category choice a harder judgment call for the model and, on at least
// this one run, pushed it past 2000 tokens before it ever produced a
// complete text block. Raising the cap to 4000 and adding a fourth attempt
// gives the escalation ladder (500 -> 1000 -> 2000 -> 4000) one more
// doubling step to actually reach the budget that's needed, instead of
// giving up right at the point the previous ceiling was already proven
// insufficient.
async function callAnthropic(prompt: string, initialMaxTokens: number): Promise<string> {
  const maxAttempts = 4;
  let lastError: Error | undefined;
  let maxTokens = initialMaxTokens;
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
        const hitMaxTokens = data.stop_reason === "max_tokens";
        throw new Error(
          `Claude returned no text content (stop_reason: ${data.stop_reason ?? "unknown"})` +
            (hitMaxTokens ? ` — cut off before any text was emitted at max_tokens=${maxTokens}` : "")
        );
      }
      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        if (lastError.message.includes("cut off before any text was emitted")) {
          maxTokens = Math.min(maxTokens * 2, 4000);
        }
        await sleep(attempt * 500);
      }
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
//
// 2026-07-19 second-order fix — the streak rule above only prevents 3
// *consecutive* questions in one category; it does nothing to stop a
// category from being revisited over and over with gaps in between. A full
// 90-question persona eval run (docs/handover_2026-07-19-qa-persona-eval.md)
// scored 91/100 but its own grading pass caught exactly this: community_faith
// and passions each got 4 of the 45 follow-up slots (Q40/Q69 both asked
// "where did you belong" 29 questions apart; Q41/51/62/87 all mined "things
// you do for yourself"), while parenthood/partnership/childhood only got 1
// each. Added a full-interview category tally and an explicit instruction to
// prefer the least-used categories, treating 3 as a soft ceiling, plus a
// rule against reusing the same illustrative anecdote as the centerpiece of
// two different questions (the same eval run's Q9/Q63 both centered on the
// one "never left a room without turning off the light" story).
//
// 2026-07-19 fourth fix, same day — the "full list of every question ever
// asked" (priorQuestionTexts) that both the duplicate-check and the category
// tally used to read from grew without any ceiling: every question, forever,
// appended to every single follow-up prompt. Tim asked what a real follow-up
// call actually cost by question 90 (~1.4 cents and climbing every question
// after) and whether a running summary would help. It does, and the tally
// above never actually needed the raw list in the first place — it only
// ever read each entry's lifePhase. `biographySections` (built and
// continuously merged in place by updateBiographySectionSummary, one row per
// category, see biography.service.ts) replaces priorQuestionTexts here:
// each category's already-asked question stems are scoped to that one
// category (so still precise for duplicate-detection) and its running
// summary tells the model what's already covered without ever needing the
// full raw history. Bounded by how much there actually is to say about each
// of the eighteen categories, not by how many questions have been asked —
// flat instead of growing forever.
export async function generateFollowUpQuestion(input: {
  personName: string;
  priorQAs: PriorQA[];
  biographySections: { lifePhase: string; summary: string; askedQuestionStems: string[] }[];
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

  const coverageText = input.biographySections
    .filter((s) => s.summary.trim().length > 0)
    .map((s) => `${s.lifePhase} (${s.askedQuestionStems.length} asked): ${s.summary}\n  Already asked in this category: ${s.askedQuestionStems.join(" | ")}`)
    .join("\n\n");

  const categoryList = INTERVIEW_CATEGORIES.join(", ");
  const recentCategoriesText = input.recentCategories.length ? input.recentCategories.join(" -> ") : "(none yet)";

  const categoryCounts = tallyCategoryCounts(input.biographySections);
  const categoryCountsText = [...categoryCounts.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([c, n]) => `${c}: ${n}`)
    .join(", ");

  const prompt = `You are helping build a family history archive through a structured life-story interview. Below is ${input.personName}'s interview so far — general life questions spanning categories like childhood, education, work, relationships, family, values, and legacy, with the life phase noted alongside each one, and their answers.

${context}

What's already been covered in this interview so far, by category — a running summary, not a full transcript, so treat it as a reliable account of what's already known even though it isn't verbatim (categories not listed below haven't been touched yet):

${coverageText || "(nothing covered yet)"}

The eighteen life-story categories this interview draws from: ${categoryList}.

The categories of the most recent questions, in order (oldest to newest): ${recentCategoriesText}.

How many questions have been asked in each category across the WHOLE interview so far, least to most: ${categoryCountsText}.

The curated set of general life questions has been fully answered. Write ONE follow-up question that stays in that same register — a general life question, not a drill into one narrow specific memory, anecdote, or detail — that helps build a fuller, more complete picture of their overall life story. Prefer extending into a life area that's thin or unexplored so far, or a natural next general question suggested by what they've shared, over zooming into one specific event they mentioned. Check your draft question against the coverage summary above, especially the "already asked in this category" lists — do not ask anything substantively the same as a question already on one of those lists, even if worded differently or framed from a new angle. Also do not build your new question around a specific anecdote, phrase, or story detail that the summary shows already served as the centerpiece of an earlier answer — ask about a different part of their life instead, even if it's the same general category.

Also spread across categories deliberately: don't stay in one category too long. If the same category appears for three or more of the most recent questions in a row, you MUST pick a different one this time, even if that category still has more to explore — there will be other chances to come back to it later. Beyond that streak rule, strongly prefer a category near the low end of the whole-interview count above — treat 3 as a soft ceiling for any one category across the entire interview: do not pick a category that already has 3 or more questions unless every category with fewer already has 3 or more too, or this specific category has a clearly distinct, specific facet that nothing asked so far has touched.

Keep it conversational, one sentence, second person ("you"/"your"). Respond in EXACTLY this two-line format, nothing else, no preamble:
CATEGORY: <one of the eighteen category keys above, exactly as written, lowercase with underscores>
QUESTION: <the question text — no quotation marks, no numbering>`;

  // 500 rather than 250 (this call's original budget) — a real interview
  // hit max_tokens on the old value once the duplicate/category-avoidance
  // instructions had grown large by question 50. The escalating retry above
  // is the real safety net, but starting higher means it's less likely to be
  // needed at all in the common case.
  const text = await callAnthropic(prompt, 500);

  const categoryMatch = text.match(/CATEGORY:\s*(\S+)/i);
  const questionMatch = text.match(/QUESTION:\s*(.+)/is);

  const rawCategory = categoryMatch?.[1]?.trim().toLowerCase();
  const lifePhase = rawCategory && isInterviewCategory(rawCategory) ? rawCategory : leastUsedCategory(categoryCounts);

  // Falls back to the whole response as the question text if the two-line
  // format didn't parse at all — better than throwing away an otherwise
  // fine question over a formatting slip.
  const question = (questionMatch?.[1]?.trim() ?? text).replace(/^["']|["']$/g, "");

  return { question, lifePhase };
}

// 2026-07-19 fourth fix, same day — the other half of the biographySections
// change above. Called once per transcribed answer, from
// biography.service.ts's recordAnswerInBiography (the DB-orchestrating
// caller — this function itself stays pure, no DB access, same convention
// as the rest of this file). Deliberately narrow: it only ever folds ONE new
// Q&A into the existing summary for the ONE category that answer belongs
// to, never rewrites anything else — so unlike the old raw-question-list
// approach, the cost of keeping this up to date doesn't grow with how long
// the interview has been running, only with how much there actually is to
// say about that one category (and the prompt below explicitly asks the
// model to tighten older material rather than let any one section grow
// without bound).
export async function updateBiographySectionSummary(input: {
  personName: string;
  lifePhase: string;
  existingSummary: string;
  question: string;
  answer: string;
}): Promise<string> {
  if (!env.anthropicApiKey) {
    throw new Error(
      "updateBiographySectionSummary is not configured — set ANTHROPIC_API_KEY. See docs/section2_pipeline.md section 4."
    );
  }

  const prompt = `You are maintaining a running biographical summary of ${input.personName}'s life, one life-story category at a time — this one is "${input.lifePhase}". It's later assembled together with the other categories into a "who they were" narrative for their family, so it should read like real biographical prose, not interview notes.

Current summary of this category so far (may be empty if nothing's been covered yet):
${input.existingSummary || "(nothing yet)"}

A new question in this category was just answered:
Q: ${input.question}
A: ${input.answer}

Write an UPDATED summary for this one category that folds the new answer in naturally alongside what's already known — integrate it, don't just tack a new sentence on the end. Keep specific names, dates, and concrete details (they're what make this feel like a real person, not a generic bio), but stay tight: no more than 5-6 sentences total for this whole category, even as more gets added over time — if it's getting long, tighten or drop less-important older material rather than letting it grow forever. Third person ("he"/"she"/"they"), warm biographical prose, no headers, no bullet points, no preamble — just the summary text itself.`;

  return callAnthropic(prompt, 400);
}

// The "who they were" paragraph GET /persons/:id/summary (persons.routes.ts)
// has been reading from persons.ai_summary since migration 003, with
// nothing ever writing to it — the route's own comment called it "still a
// stub." Assembled here from the same per-category summaries
// updateBiographySectionSummary keeps current, never from the raw
// transcript, so this stays cheap regardless of how long someone's been
// answering questions. Doubles as the legacy document Tim asked about: if
// the interview subject passes away, this is a real, readable "who they
// were" biography for the family, not a pile of raw Q&A to dig through.
export async function synthesizeBiography(input: {
  personName: string;
  sections: { lifePhase: string; summary: string }[];
}): Promise<string> {
  if (!env.anthropicApiKey) {
    throw new Error("synthesizeBiography is not configured — set ANTHROPIC_API_KEY. See docs/section2_pipeline.md section 4.");
  }

  const nonEmpty = input.sections.filter((s) => s.summary.trim().length > 0);
  if (nonEmpty.length === 0) {
    throw new Error("synthesizeBiography needs at least one non-empty biography section to work from");
  }

  const sectionsText = nonEmpty.map((s) => `${s.lifePhase}: ${s.summary}`).join("\n\n");

  const prompt = `Below are per-category running summaries of ${input.personName}'s life story, gathered through a family history interview.

${sectionsText}

Write a single flowing "who they were" biography, a few warm paragraphs, weaving these categories together into one coherent life story rather than listing them one by one — the way a family member might describe someone they loved, not a résumé. Keep concrete, specific details (names, dates, particular stories) rather than generic statements. Third person. No headers, no bullet points, no category labels, no preamble — just the biography itself.`;

  return callAnthropic(prompt, 1200);
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

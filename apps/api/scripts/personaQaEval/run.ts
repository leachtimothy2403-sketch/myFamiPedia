// Adaptive Q&A persona eval (docs/handover_2026-07-19-qa-persona-eval.md).
//
// NOT a vitest test — deliberately not named *.test.ts so `pnpm test`/CI
// never picks it up. It makes real, paid Anthropic API calls (one per
// question for the persona's answer, plus one grading call at the end) and
// is non-deterministic by nature (an LLM playing a character), so it's a
// manual eval you run when you want a read on adaptive Q&A quality — e.g.
// after touching claude.service.ts's generateFollowUpQuestion prompt again —
// not something that should gate every commit.
//
// What it does: boots the same in-memory pglite Postgres the real test
// suite uses, seeds the curated question bank, registers a throwaway user,
// then works through the REAL GET /interview-questions/next endpoint
// exactly like the mobile app does — curated bank first, then
// Claude-generated follow-ups once that's exhausted. Each question is
// answered by a second Claude call playing a fully fictional persona
// (persona.ts) instructed to answer like a real interview subject: warm and
// specific on topics they're open about, brief and deflecting on a handful
// of deliberately "buried" facts they'd only reveal if asked well. Answers
// are seeded directly into interview_answers with transcript already set —
// bypassing the real endpoint's audioR2Key requirement on purpose (that's a
// separately-tested, orthogonal concern; this eval is about question
// quality, not transcription). Ends with a grading pass: a third Claude call
// compares the full transcript against the ground-truth bio and reports
// which buried facts got surfaced, which life areas stayed thin, and
// whether any follow-up repeated itself — the failure mode a real bug once
// caused (docs/handover_2026-07-17-adaptive-qa-round2.md's "Tour de France"
// fixation).
//
// Run from apps/api: `pnpm eval:qa-persona`
// Requires ANTHROPIC_API_KEY in the repo root .env — the same key the app
// itself needs for adaptive follow-ups, so if the real feature works today
// this should too.
// Optional: QA_EVAL_MAX_FOLLOWUPS (default 12) caps how many generated
// follow-ups to run before stopping — otherwise the loop only ends when the
// model itself stops (it doesn't reliably self-terminate).

import fs from "node:fs";
import path from "node:path";
import supertest from "supertest";
import { createTestDb } from "../../tests/helpers/testDb";
import { PERSONA_NAME, PERSONA_BIO, PERSONA_ANSWER_SYSTEM_PROMPT, BURIED_FACTS } from "./persona";

const MAX_FOLLOWUPS = Number(process.env.QA_EVAL_MAX_FOLLOWUPS ?? 12);

interface QuestionRow {
  id: string;
  text: string;
  life_phase: string;
  source: "curated" | "generated";
}

interface TranscriptEntry {
  index: number;
  source: "curated" | "generated";
  lifePhase: string;
  question: string;
  answer: string;
}

async function callClaude(system: string | undefined, userPrompt: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This eval needs the same key generateFollowUpQuestion uses in production — add it to the repo root .env."
    );
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude request failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((b) => b.type === "text")?.text?.trim();
  if (!text) throw new Error("Claude returned no text content");
  return text;
}

async function answerAsPersona(transcript: TranscriptEntry[], question: string): Promise<string> {
  const history = transcript.length
    ? transcript.map((t) => `Q: ${t.question}\nYour answer: ${t.answer}`).join("\n\n")
    : "(This is the first question — no prior conversation yet.)";
  const prompt = `Here is the interview so far:\n\n${history}\n\nNew question: ${question}\n\nAnswer as yourself, following your own instructions above about tone, length, and what to share versus hold back.`;
  return callClaude(PERSONA_ANSWER_SYSTEM_PROMPT, prompt, 300);
}

async function main() {
  console.log("Booting in-memory Postgres (pglite)...");
  const testDb = await createTestDb();
  const { db } = await import("../../src/db/pool");
  await db.migrate.latest();

  // The seed file is a plain CommonJS module (exports.seed = ...) — handle
  // both interop shapes rather than guessing which one Node's ESM/CJS
  // bridge produces here.
  const seedModule = (await import("../../src/db/seeds/001_interview_questions.js")) as {
    seed?: (knex: typeof db) => Promise<void>;
    default?: { seed: (knex: typeof db) => Promise<void> };
  };
  const seedFn = seedModule.seed ?? seedModule.default?.seed;
  if (!seedFn) throw new Error("Could not resolve the curated-question seed function");
  await seedFn(db);

  const { default: app } = await import("../../src/index");
  const request = () => supertest(app);

  console.log(`Registering throwaway account for ${PERSONA_NAME}...`);
  const email = `qa-eval-${Date.now()}@example.com`;
  const registerRes = await request()
    .post("/api/v1/auth/register")
    .send({ email, password: "eval-persona-pass-1", name: PERSONA_NAME });
  if (registerRes.status !== 201) {
    throw new Error(`Register failed: ${registerRes.status} ${JSON.stringify(registerRes.body)}`);
  }
  const accessToken = registerRes.body.accessToken as string;
  const decoded = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString());
  const personId = decoded.personId as string;

  const sessionRes = await request()
    .post("/api/v1/interview-sessions")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ personId });
  if (sessionRes.status !== 201) {
    throw new Error(`Creating interview session failed: ${sessionRes.status} ${JSON.stringify(sessionRes.body)}`);
  }
  const sessionId = sessionRes.body.id as string;

  const transcript: TranscriptEntry[] = [];
  let curatedCount = 0;
  let followupCount = 0;

  console.log("\nStarting interview loop...\n");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const nextRes = await request()
      .get(`/api/v1/interview-questions/next?personId=${personId}`)
      .set("Authorization", `Bearer ${accessToken}`);

    if (nextRes.status === 204) {
      console.log("GET /interview-questions/next returned 204 (nothing left) — stopping.");
      break;
    }
    if (nextRes.status !== 200) {
      throw new Error(`GET /interview-questions/next failed: ${nextRes.status} ${JSON.stringify(nextRes.body)}`);
    }
    const q = nextRes.body as QuestionRow;
    const isGenerated = q.source === "generated";

    if (isGenerated && followupCount >= MAX_FOLLOWUPS) {
      console.log(`Reached QA_EVAL_MAX_FOLLOWUPS (${MAX_FOLLOWUPS}) — stopping.`);
      break;
    }

    const answerText = await answerAsPersona(transcript, q.text);

    // Seeded directly, on purpose — see the file header on why this bypasses
    // POST /interview-sessions/:id/answers (audio-only) rather than faking
    // audio, while still exercising the real question-selection/generation
    // endpoint above unchanged.
    await db("interview_answers").insert({
      session_id: sessionId,
      question_id: q.id,
      audio_r2_key: "eval://not-a-real-recording",
      transcript: answerText,
    });

    if (isGenerated) followupCount++;
    else curatedCount++;

    transcript.push({
      index: transcript.length + 1,
      source: isGenerated ? "generated" : "curated",
      lifePhase: q.life_phase,
      question: q.text,
      answer: answerText,
    });
    console.log(`[${transcript.length}] (${q.source}/${q.life_phase})\nQ: ${q.text}\nA: ${answerText}\n`);
  }

  console.log(`\nInterview complete — ${curatedCount} curated, ${followupCount} generated follow-up question(s).\n`);
  console.log("Running grading pass...\n");

  const transcriptText = transcript
    .map((t) => `${t.index}. [${t.source}/${t.lifePhase}] Q: ${t.question}\nA: ${t.answer}`)
    .join("\n\n");

  const gradingPrompt = `Ground-truth life story:

${PERSONA_BIO}

Deliberately buried facts to check for (each was written into the bio to only ever surface if asked well — never given away for free by the persona):
${BURIED_FACTS.map((f, i) => `${i + 1}. ${f}`).join("\n")}

Full interview transcript:

${transcriptText}

Grade this interview's coverage of the person's life story. Respond in exactly this structure:

COVERAGE SCORE: <0-100>

BURIED FACTS SURFACED:
<for each numbered buried fact above, say SURFACED or NOT SURFACED; if surfaced, cite which question number drew it out>

THIN OR UNEXPLORED AREAS:
<list any major life categories from the ground truth that got little or no coverage>

REPEATED OR NEAR-DUPLICATE QUESTIONS:
<list any follow-up questions that were substantively the same as an earlier one in this transcript, by question number, or write "none">

NOTES:
<anything else worth flagging about question quality, register (too specific vs. appropriately general), or pacing>`;

  const gradingReport = await callClaude(undefined, gradingPrompt, 1200);

  const outPath = path.join(process.cwd(), `qa-persona-eval-report-${Date.now()}.md`);
  const fullReport = `# Adaptive Q&A persona eval report

Persona: ${PERSONA_NAME}
Curated questions answered: ${curatedCount}
Follow-up questions answered: ${followupCount}

## Transcript

${transcriptText}

## Grading

${gradingReport}
`;
  fs.writeFileSync(outPath, fullReport);
  console.log(`Report written to ${outPath}`);

  await db.destroy();
  await testDb.teardown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

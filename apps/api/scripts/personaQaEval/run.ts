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
// Optional: QA_EVAL_MAX_FOLLOWUPS (default 45 — matching the curated bank's
// own 45 questions, so a full run is a genuinely deep interview: 45 curated
// + up to 45 follow-ups) caps how many generated follow-ups to run before
// stopping — otherwise the loop only ends when the model itself stops (it
// doesn't reliably self-terminate).

import fs from "node:fs";
import path from "node:path";
import supertest from "supertest";
import { createTestDb } from "../../tests/helpers/testDb";
import { PERSONA_NAME, PERSONA_BIO, PERSONA_ANSWER_SYSTEM_PROMPT, BURIED_FACTS } from "./persona";

const MAX_FOLLOWUPS = Number(process.env.QA_EVAL_MAX_FOLLOWUPS ?? 45);

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 2026-07-19 fix — a real run (42 questions in, mid-interview) hit "Claude
// returned no text content" and the whole script died, losing every answer
// gathered so far, including the persona's jazz-singing reveal — exactly
// the kind of thing this eval exists to catch. The underlying cause wasn't
// diagnosable from the old error (it swallowed the raw response entirely),
// and a single bad/empty response from a long-running, many-call script
// shouldn't be fatal on its own. Now retries transiently-bad responses
// (empty content, 5xx, network errors) a few times with backoff, and logs
// the raw response body on final failure so a *real* recurring problem is
// actually diagnosable next time instead of a bare "no text content".
async function callClaude(system: string | undefined, userPrompt: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This eval needs the same key generateFollowUpQuestion uses in production — add it to the repo root .env."
    );
  }

  const maxAttempts = 3;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
      const rawBody = await res.text();
      const data = JSON.parse(rawBody) as { content: { type: string; text?: string }[]; stop_reason?: string };
      const text = data.content?.find((b) => b.type === "text")?.text?.trim();
      if (!text) {
        throw new Error(
          `Claude returned no text content (stop_reason: ${data.stop_reason ?? "unknown"}). Raw response: ${rawBody.slice(0, 500)}`
        );
      }
      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const backoffMs = attempt * 2000;
        console.warn(`  (Claude call failed on attempt ${attempt}/${maxAttempts}, retrying in ${backoffMs}ms: ${lastError.message})`);
        await sleep(backoffMs);
      }
    }
  }
  throw lastError ?? new Error("Claude call failed for an unknown reason");
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

  // 2026-07-19 fix — a transient failure partway through a long run (a real
  // one hit this at question 42/90) used to take the whole transcript down
  // with it. Writes whatever was gathered so far, clearly labeled as
  // incomplete, rather than losing it — the answers already collected are
  // still worth reading even without a grading pass, and rerunning a 90-question
  // interview from scratch over one bad API response is expensive for no reason.
  function writeReport(gradingReport: string | null, incomplete: boolean) {
    const transcriptText = transcript
      .map((t) => `${t.index}. [${t.source}/${t.lifePhase}] Q: ${t.question}\nA: ${t.answer}`)
      .join("\n\n");
    const outPath = path.join(
      process.cwd(),
      `qa-persona-eval-report-${Date.now()}${incomplete ? "-INCOMPLETE" : ""}.md`
    );
    const fullReport = `# Adaptive Q&A persona eval report${incomplete ? " (INCOMPLETE — the run failed partway through, see below)" : ""}

Persona: ${PERSONA_NAME}
Curated questions answered: ${curatedCount}
Follow-up questions answered: ${followupCount}

## Transcript

${transcriptText}

## Grading

${gradingReport ?? "(not run — the interview loop failed before reaching the grading pass; see the console error above)"}
`;
    fs.writeFileSync(outPath, fullReport);
    console.log(`Report written to ${outPath}`);
    return outPath;
  }

  console.log("\nStarting interview loop...\n");
  try {
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

      // Seeded directly, on purpose — see the file header on why this
      // bypasses POST /interview-sessions/:id/answers (audio-only) rather
      // than faking audio, while still exercising the real
      // question-selection/generation endpoint above unchanged.
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
  } catch (err) {
    console.error("\nInterview loop failed — writing what was gathered so far before exiting.\n");
    writeReport(null, true);
    throw err;
  }

  console.log(`\nInterview complete — ${curatedCount} curated, ${followupCount} generated follow-up question(s).\n`);
  console.log("Running grading pass...\n");

  const transcriptTextForGrading = transcript
    .map((t) => `${t.index}. [${t.source}/${t.lifePhase}] Q: ${t.question}\nA: ${t.answer}`)
    .join("\n\n");

  const gradingPrompt = `Ground-truth life story:

${PERSONA_BIO}

Deliberately buried facts to check for (each was written into the bio to only ever surface if asked well — never given away for free by the persona):
${BURIED_FACTS.map((f, i) => `${i + 1}. ${f}`).join("\n")}

Full interview transcript:

${transcriptTextForGrading}

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

  // Scales with transcript length rather than a fixed cap — a fixed 1200
  // was tuned against a short test run and silently truncated mid-sentence
  // once a real run (15 curated + a couple dozen follow-ups) gave the
  // grading pass that much more to summarize. 120 tokens/entry plus a fixed
  // base comfortably covers the structured sections below even for a long
  // interview; capped at 6000 as a sanity ceiling (only a ceiling — Claude
  // is billed for tokens actually generated, not this cap, so erring high
  // here is free).
  const gradingMaxTokens = Math.min(6000, 800 + transcript.length * 120);

  let gradingReport: string;
  try {
    gradingReport = await callClaude(undefined, gradingPrompt, gradingMaxTokens);
  } catch (err) {
    console.error("\nGrading pass failed — writing the transcript without it rather than losing the interview.\n");
    writeReport(null, true);
    throw err;
  }

  writeReport(gradingReport, false);

  await db.destroy();
  await testDb.teardown();

  // Importing src/index pulls in every BullMQ queue (jobs/queue.ts) as a
  // side effect, same as the real API process — those hold open ioredis
  // sockets that retry forever if Redis isn't reachable (or just stay open
  // indefinitely if it is), which keeps the event loop alive with nothing
  // left for this script to do. Without this, the terminal never returns to
  // a prompt even though everything above already finished successfully —
  // not a hang, just an explicit exit nothing else was going to trigger.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

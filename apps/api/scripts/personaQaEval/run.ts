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
// quality, not transcription). recordAnswerInBiography is called explicitly
// right after that insert (docs/handover_2026-07-19-qa-persona-eval.md,
// "sixth-order fix") — in production that only ever happens inside
// transcribeAnswer.ts's processTranscribeJob, which this script's direct
// insert has no reason to go through, so without this explicit call
// interview_biography_sections stayed empty for the whole eval run and
// generateFollowUpQuestion had zero coverage signal to work with. Ends with
// a grading pass: a third Claude call
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
//
// Optional: a persona key, as either a CLI arg (`tsx run.ts terse`) or the
// QA_EVAL_PERSONA env var — the CLI arg form is what package.json's scripts
// use (`pnpm eval:qa-persona-terse`), since it works identically in
// PowerShell, cmd, and bash with no extra dependency (no cross-env) needed;
// the env var form is there for anyone who prefers setting it that way.
// "peggy" (default, ./persona.ts — warm, associative, deliberately deflects
// on sensitive topics) or "terse" (./personaTerse.ts — Walter "Bud" Okafor,
// literal and chronological, buries facts through brevity rather than
// deflection, never hints a topic is sensitive). Added 2026-07-19 per the
// "known gaps" callout in docs/handover_2026-07-19-qa-persona-eval.md: one
// persona's phrasing quirks could flatter or unfairly penalize the system
// independent of whether the underlying adaptive-question logic is actually
// sound — running a contrasting archetype is the check for that. Add more
// personas the same way: a new file exporting the same four names
// (PERSONA_NAME, PERSONA_BIO, PERSONA_ANSWER_SYSTEM_PROMPT, BURIED_FACTS),
// registered below.

import fs from "node:fs";
import path from "node:path";
import supertest from "supertest";
import { createTestDb } from "../../tests/helpers/testDb";
import * as peggyPersona from "./persona";
import * as tersePersona from "./personaTerse";

// recordAnswerInBiography is deliberately NOT a static import up here, even
// though every other application-code import in this file (db/pool.ts, the
// seed module, src/index) is a dynamic import placed inside main() after
// createTestDb() runs - see that function's own docstring in
// tests/helpers/testDb.ts: config/env.ts reads process.env.DATABASE_URL
// once at module-import time, and static imports are hoisted to the top of
// the module regardless of where they're written in the file. A static
// import here would pull in biography.service.ts -> claude.service.ts ->
// config/env.ts BEFORE createTestDb() ever gets to point DATABASE_URL at
// the throwaway pglite instance - which is exactly the bug that shipped
// once (docs/handover_2026-07-19-qa-persona-eval.md, "seventh-order fix"):
// config/env.ts silently locked onto Tim's real dev DATABASE_URL instead,
// and the seed script's del() correctly failed against his real,
// already-answered interview_questions rows.

const PERSONAS = { peggy: peggyPersona, terse: tersePersona } as const;
type PersonaKey = keyof typeof PERSONAS;

const personaKey = (process.argv[2] ?? process.env.QA_EVAL_PERSONA ?? "peggy").toLowerCase() as PersonaKey;
if (!(personaKey in PERSONAS)) {
  throw new Error(`Unknown persona "${personaKey}" — expected one of: ${Object.keys(PERSONAS).join(", ")}`);
}
const { PERSONA_NAME, PERSONA_BIO, PERSONA_ANSWER_SYSTEM_PROMPT, BURIED_FACTS } = PERSONAS[personaKey];

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
// 2026-07-19 second fix, same day — plain retry (above the diff) wasn't
// enough on its own. A deep real interview (question 50) hit the same "no
// text content" failure but with stop_reason: max_tokens — the model got
// cut off before ever emitting a text block, a deterministic failure given
// the same token budget, not a random glitch. Retrying 3x at the same
// budget just failed the same way 3 times. Now, when a failure is
// specifically a max_tokens cutoff with no text produced, the next attempt
// doubles the budget (capped at 2000) instead of just waiting and repeating
// verbatim — a genuinely transient failure (5xx, an empty response for no
// discernible reason) still just gets a plain backoff-and-retry. Mirrors
// the same fix in claude.service.ts's callAnthropic (production code hit
// this too) — kept as a separate copy here since this script is
// intentionally standalone/dependency-light, not because the logic differs.
// 2026-07-19 third fix, same day — a live run of this exact script (Peggy,
// 90 questions) hit the same wall at question 65: 500 -> 1000 -> 2000 all
// cut off with zero text, exhausting all 3 attempts. Mirrors the same fix
// made in claude.service.ts's callAnthropic: one more attempt, cap raised to
// 4000, so the ladder is 500 -> 1000 -> 2000 -> 4000.
async function callClaude(system: string | undefined, userPrompt: string, initialMaxTokens: number): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This eval needs the same key generateFollowUpQuestion uses in production — add it to the repo root .env."
    );
  }

  const maxAttempts = 4;
  let lastError: Error | undefined;
  let maxTokens = initialMaxTokens;
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
        const hitMaxTokens = data.stop_reason === "max_tokens";
        throw new Error(
          `Claude returned no text content (stop_reason: ${data.stop_reason ?? "unknown"})` +
            (hitMaxTokens ? ` — cut off before any text was emitted at max_tokens=${maxTokens}` : "") +
            `. Raw response: ${rawBody.slice(0, 500)}`
        );
      }
      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        if (lastError.message.includes("cut off before any text was emitted")) {
          maxTokens = Math.min(maxTokens * 2, 4000);
        }
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
  // 500 rather than 300 (this call's original budget) — same headroom bump
  // as claude.service.ts's callAnthropic, for the same reason: a long
  // interview's accumulated history can make an answer want more room.
  return callClaude(PERSONA_ANSWER_SYSTEM_PROMPT, prompt, 500);
}

async function main() {
  console.log("Booting in-memory Postgres (pglite)...");
  const testDb = await createTestDb();
  const { db } = await import("../../src/db/pool");
  const { recordAnswerInBiography } = await import("../../src/services/biography.service");
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
  let accessToken = registerRes.body.accessToken as string;
  let refreshToken = registerRes.body.refreshToken as string;
  const decoded = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString());
  const personId = decoded.personId as string;
  const familyGroupId = decoded.familyGroupId as string;

  const sessionRes = await request()
    .post("/api/v1/interview-sessions")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ personId });
  if (sessionRes.status !== 201) {
    throw new Error(`Creating interview session failed: ${sessionRes.status} ${JSON.stringify(sessionRes.body)}`);
  }
  const sessionId = sessionRes.body.id as string;

  // 2026-07-19 fix — a real run (peggy, 77 questions in, several minutes)
  // died with "GET /interview-questions/next failed: 401 Invalid or expired
  // token". Access tokens expire after 15m (auth.routes.ts's issueTokens),
  // and a long interview easily outlives that once every question's
  // persona-answer + biography-summary + next-question Claude calls (plus
  // any retry backoff) are counted. One refresh-and-retry on a 401 covers
  // it; if a fresh token still 401s, something else is actually wrong and
  // that should surface as a real failure rather than be retried forever.
  async function fetchNextQuestion() {
    let res = await request()
      .get(`/api/v1/interview-questions/next?personId=${personId}`)
      .set("Authorization", `Bearer ${accessToken}`);
    if (res.status === 401) {
      console.warn("  (access token expired mid-run, refreshing via /auth/refresh and retrying...)");
      const refreshRes = await request().post("/api/v1/auth/refresh").send({ refreshToken });
      if (refreshRes.status !== 200) {
        throw new Error(`Token refresh failed: ${refreshRes.status} ${JSON.stringify(refreshRes.body)}`);
      }
      accessToken = refreshRes.body.accessToken as string;
      refreshToken = refreshRes.body.refreshToken as string;
      res = await request()
        .get(`/api/v1/interview-questions/next?personId=${personId}`)
        .set("Authorization", `Bearer ${accessToken}`);
    }
    return res;
  }

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
      `qa-persona-eval-report-${personaKey}-${Date.now()}${incomplete ? "-INCOMPLETE" : ""}.md`
    );
    const fullReport = `# Adaptive Q&A persona eval report${incomplete ? " (INCOMPLETE — the run failed partway through, see below)" : ""}

Persona: ${PERSONA_NAME} (${personaKey})
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
      const nextRes = await fetchNextQuestion();

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
      const [evalMemory] = await db("memories")
        .insert({
          family_group_id: familyGroupId,
          contributor_id: personId,
          content: answerText,
          provenance_type: "voice",
          provenance_label: q.text,
        })
        .returning("*");
      await db("interview_answers").insert({
        session_id: sessionId,
        question_id: q.id,
        audio_r2_key: "eval://not-a-real-recording",
        transcript: answerText,
        memory_id: evalMemory.id,
      });

      // See the file header — this is the explicit stand-in for what
      // processTranscribeJob does in production. Not wrapped as loosely as
      // the try/catch around Claude retries above: a failure here should be
      // loud, not silently leave a category's coverage signal stale for the
      // rest of a 90-question run the way it did before this was wired in
      // at all.
      //
      // 2026-07-20 — migration 028's interview_biography_sources needs a real
      // memory_id now (so a later retraction of that memory could recompute
      // this section) — evalMemory above is the eval's stand-in for the
      // memories row processTranscribeJob would normally create.
      try {
        await recordAnswerInBiography(db, {
          personId,
          personName: PERSONA_NAME,
          lifePhase: q.life_phase,
          question: q.text,
          answer: answerText,
          memoryId: evalMemory.id,
        });
      } catch (err) {
        console.warn(`  (biography update failed for question ${transcript.length + 1}, continuing: ${err instanceof Error ? err.message : String(err)})`);
      }

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

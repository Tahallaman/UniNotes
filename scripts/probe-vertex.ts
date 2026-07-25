/**
 * Verify that the configured Vertex AI model is reachable from this project.
 *
 * Run this before relying on the "api" provider — it fails fast with a clear
 * message instead of surfacing as a mid-pipeline error 40 minutes into a run.
 *
 * Usage:
 *   npx tsx scripts/probe-vertex.ts
 *   npx tsx scripts/probe-vertex.ts --model gemini-3.5-flash --location us-central1
 */

import { GoogleGenAI } from "@google/genai";
import { CONFIG } from "../config.js";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline?.split("=").slice(1).join("=");
}

const project = process.env.GOOGLE_CLOUD_PROJECT || CONFIG.vertex.project;
const location = argValue("location") || process.env.GOOGLE_CLOUD_LOCATION || CONFIG.vertex.location;
const model = argValue("model") || CONFIG.vertex.model;

console.log(`project  : ${project}`);
console.log(`location : ${location}`);
console.log(`model    : ${model}`);
console.log();

const client = new GoogleGenAI({ vertexai: true, project, location });

let failed = false;

// 1. countTokens — free, and proves the model path resolves.
try {
  const res = await client.models.countTokens({
    model,
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  });
  console.log(`[OK]   countTokens      → totalTokens=${res.totalTokens}`);
} catch (err) {
  failed = true;
  console.error(`[FAIL] countTokens      → ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Ask for a fixed reply and report exactly what came back.
 *
 * Reporting finishReason and the thinking/output token split is the whole point.
 * Gemini 3.x charges thinking against maxOutputTokens and returns an EMPTY string
 * — not a partial answer — when thinking exhausts it. A probe that printed only
 * "empty response" for that sent you looking at billing and quota when the API
 * was working perfectly.
 */
async function probeGenerate(label: string, config: Record<string, unknown>): Promise<void> {
  try {
    const res = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: PROBE OK" }] }],
      config: { ...config, httpOptions: { timeout: 60_000 } },
    });

    const text = (res.text ?? "").trim();
    const finishReason = res.candidates?.[0]?.finishReason ?? "unknown";
    const usage = res.usageMetadata as { thoughtsTokenCount?: number; candidatesTokenCount?: number } | undefined;
    const tokens = `thinking=${usage?.thoughtsTokenCount ?? 0} output=${usage?.candidatesTokenCount ?? 0}`;

    if (text) {
      console.log(`[OK]   ${label} → ${JSON.stringify(text.slice(0, 120))} (${tokens})`);
      return;
    }

    failed = true;
    console.error(`[FAIL] ${label} → empty response, finishReason=${finishReason} (${tokens})`);
    if (finishReason === "MAX_TOKENS") {
      console.error(
        `       Thinking used the entire token budget. This is a budget problem, not an\n` +
          `       access problem — raise maxOutputTokens or set thinkingBudget: 0.`,
      );
    }
  } catch (err) {
    failed = true;
    console.error(`[FAIL] ${label} → ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 2. Generation with thinking off — the cleanest possible test of billing and quota.
await probeGenerate("generate (no thinking)", {
  maxOutputTokens: 256,
  thinkingConfig: { thinkingBudget: 0 },
});

// 3. Generation with thinking on, at the headroom the notes stage actually uses.
//    The notes path leaves thinking enabled, so a probe that only tested it
//    disabled would pass while the real pipeline returned empty strings.
await probeGenerate("generate (thinking)", {
  maxOutputTokens: CONFIG.vertex.generation.notes.maxOutputTokens,
});

console.log();
if (failed) {
  console.error("Probe FAILED. Common causes:");
  console.error(`  404  → "${model}" is not served in location "${location}". Try --location us-central1 (or global).`);
  console.error("  403  → billing disabled, aiplatform.googleapis.com not enabled, or ADC lacks aiplatform.user.");
  console.error("  401  → stale credentials. Run: gcloud auth application-default login");
  console.error("  MAX_TOKENS → thinking consumed the output budget; the API itself is fine.");
  process.exit(1);
}

console.log(`Probe passed — "${model}" is usable at location "${location}".`);

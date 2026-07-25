import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";
import { log, type LogContext } from "../utils/logger.js";
import { generateText } from "../gemini/vertexGenerate.js";
import { vertexLimit, classifyError, backoffDelay, sleep } from "../gemini/vertexClient.js";
import { withTab } from "../gemini/browserPool.js";
import { uploadFileToGemini } from "../gemini/uploader.js";
import { submitPromptAndWaitForResponse } from "../gemini/prompter.js";

export type PrettyProvider = "api" | "browser";

/** Below this, the model clearly didn't do the job. */
const MIN_PRETTY_LENGTH = 100;

/**
 * Overrides rule 9 of prompts/pretty-notes.txt ("preserve the frontmatter").
 *
 * Asking the model to reproduce the frontmatter is unreliable and, on the browser
 * path, actively broken: Gemini's web UI renders "---" as an <hr>, so innerText
 * extraction returns the YAML body as loose plain text with the fences gone. We
 * re-attach the original block ourselves instead, which also guarantees it stays
 * byte-identical to what writeNotes wrote.
 */
const FRONTMATTER_INSTRUCTION =
  "Do NOT output the YAML frontmatter block (the '---' delimited header) — it is " +
  "handled separately and will be re-attached. Begin your output at the first markdown heading.";

const BROWSER_INSTRUCTION =
  "Reformat the attached lecture notes according to the FORMATTING RULES above. " +
  "Output ONLY the polished markdown, nothing else. Do not add commentary before or after. " +
  FRONTMATTER_INSTRUCTION;

/**
 * The formatting rules, from CONFIG (default: prompts/pretty-notes.txt, editable
 * in the control panel under Settings → Prompts).
 *
 * Blank means the file is missing and no override was set. Refused rather than
 * sent, because a prettify prompt with no rules in it returns a rewrite of the
 * notes with none of the structure that is the entire point of the stage.
 */
function readRules(): string {
  const rules = CONFIG.prompts.prettyRules.trim();
  if (rules.length === 0) {
    throw new Error(
      `No prettifier rules: ${path.join(CONFIG.paths.prompts, "pretty-notes.txt")} is missing ` +
        `and prompts.prettyRules is not set in settings.json.`,
    );
  }
  return rules;
}

/**
 * Run raw lecture notes through Gemini to produce a polished "pretty" version.
 * Returns the pretty markdown string.
 *
 * Provider comes from CONFIG.providers.pretty unless overridden.
 */
export async function prettifyNotes(
  rawFilePath: string,
  opts: { provider?: PrettyProvider; ctx?: LogContext } = {},
): Promise<string> {
  const provider = opts.provider ?? CONFIG.providers.pretty;
  const ctx = opts.ctx;
  const rawContent = fs.readFileSync(rawFilePath, "utf-8");
  const rules = readRules();

  log.info(`Prettifying notes via ${provider}: ${path.basename(rawFilePath)}`, ctx);

  const output =
    provider === "browser"
      ? await prettifyViaBrowser(rawFilePath, rules, ctx)
      : await prettifyViaApi(rawContent, rules, ctx);

  const cleaned = attachFrontmatter(rawContent, cleanPrettyOutput(output));

  if (cleaned.trim().length < MIN_PRETTY_LENGTH) {
    throw new Error(`Prettifier returned unexpectedly short output (${cleaned.trim().length} chars)`);
  }

  log.info(`Pretty notes generated: ${cleaned.length} chars`, ctx);
  return cleaned;
}

// ── Vertex AI path ─────────────────────────────────────────────

/**
 * Text-only generateContent — no GCS staging, since there's no video involved.
 *
 * Thinking is disabled for this call (CONFIG.vertex.generation.pretty.thinkingBudget = 0):
 * reformatting is mechanical, and thinking tokens are charged against
 * maxOutputTokens, so disabling it leaves the whole budget for actual markdown.
 */
async function prettifyViaApi(rawContent: string, rules: string, ctx?: LogContext): Promise<string> {
  const { model, maxOutputTokens, thinkingBudget } = CONFIG.vertex.generation.pretty;

  const prompt = [
    "You are reformatting university lecture notes. Output ONLY raw markdown — no commentary,",
    "no code fences around the whole document, no explanation of what you changed.",
    FRONTMATTER_INSTRUCTION,
    "",
    "FORMATTING RULES:",
    rules,
    "",
    "---",
    "",
    "LECTURE NOTES TO FORMAT:",
    rawContent,
  ].join("\n");

  const maxRetries = CONFIG.retry.maxRetries;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await vertexLimit(() =>
        generateText({
          model,
          parts: [{ text: prompt }],
          maxOutputTokens,
          thinkingBudget,
          ctx,
        }),
      );
    } catch (err) {
      lastErr = err;
      const { retryable, rateLimited, reason } = classifyError(err);
      if (!retryable || attempt === maxRetries) break;
      const wait = backoffDelay(attempt, rateLimited);
      log.warn(`Prettify attempt ${attempt + 1}/${maxRetries + 1} failed (${reason}) — retrying in ${wait}ms`, ctx);
      await sleep(wait);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Prettify via Vertex failed");
}

// ── Gemini web path ────────────────────────────────────────────

/**
 * Attach the raw .md and prompt against it, rather than pasting the notes inline.
 *
 * Gemini's web UI silently converts a long paste into a "Pasted text" attachment,
 * and lecture notes routinely cross that threshold — so pasting would take an
 * unpredictable DOM path depending on length. Attaching is the same path every time.
 *
 * waitForProcessing is false: a markdown file needs no server-side processing, so
 * the video-oriented progress phases would just add dead waiting.
 */
async function prettifyViaBrowser(
  rawFilePath: string,
  rules: string,
  ctx?: LogContext,
): Promise<string> {
  const prompt = ["FORMATTING RULES:", rules, "", BROWSER_INSTRUCTION].join("\n");

  return withTab(async (page) => {
    await uploadFileToGemini(page, rawFilePath, { waitForProcessing: false, ctx });
    const { response } = await submitPromptAndWaitForResponse(page, prompt, ctx);
    return response;
  });
}

// ── Output cleanup ─────────────────────────────────────────────

/** Strip model scaffolding without touching document content. */
function cleanPrettyOutput(text: string): string {
  let out = text.trim();

  // Unwrap a fence around the ENTIRE document (```markdown ... ```), while
  // leaving genuine inner code blocks alone.
  const fenced = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*)\n```$/);
  if (fenced) out = fenced[1];

  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/**
 * Replace whatever the model emitted as a header with the original frontmatter.
 *
 * The model is told not to produce frontmatter, but compliance isn't guaranteed,
 * and the browser path can't reproduce it faithfully anyway: Gemini renders the
 * "---" fences as <hr> elements, so innerText extraction yields the YAML body as
 * loose plain text. Left alone that lands in the document as a mangled duplicate
 * header, which is exactly what syncToWorkspace and export-notes then choke on.
 *
 * So: drop any leading frontmatter-shaped material, then prepend the real block.
 */
function attachFrontmatter(rawContent: string, prettyContent: string): string {
  const original = rawContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!original) return prettyContent;

  const body = stripLeadingFrontmatterArtifacts(prettyContent);
  return `${original[0]}\n${body}`;
}

/** YAML-ish keys writer.ts emits, used to recognise a mangled header block. */
const FRONTMATTER_KEYS = /^(title|course|date|panopto_url|gemini_chat_url|topics|summary|generated):/;

function stripLeadingFrontmatterArtifacts(content: string): string {
  let out = content.trim();

  // Case 1: a well-formed block (model ignored the instruction) — drop it.
  const wellFormed = out.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (wellFormed) {
    return out.slice(wellFormed[0].length).trimStart();
  }

  // Case 2: fences lost to <hr> rendering, leaving bare "key: value" lines.
  // Only trust this when the very first line is a known frontmatter key, so a
  // document that legitimately opens with prose is left alone.
  if (FRONTMATTER_KEYS.test(out)) {
    const firstHeading = out.search(/^#{1,3} /m);
    if (firstHeading > 0) {
      log.warn("Stripped mangled frontmatter from pretty output (rendered as plain text).");
      return out.slice(firstHeading).trimStart();
    }
  }

  // Case 3: a conversational preamble above the first heading.
  if (!out.startsWith("#")) {
    const firstHeading = out.search(/^#{1,3} /m);
    if (firstHeading > 0 && firstHeading < 400) {
      out = out.slice(firstHeading).trimStart();
    }
  }

  return out;
}

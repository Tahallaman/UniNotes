/**
 * "Explain this" — asking about the lecture while you're watching it.
 *
 * ## Why this one doesn't go through jobs.ts
 *
 * Every other button in the control panel spawns a CLI child process and streams
 * its stdout to the console. This one calls Vertex in-process, which is a
 * departure worth naming rather than discovering:
 *
 *   - Jobs run one at a time behind a PID lock. Asking what a term means must not
 *     be blocked by a prettify run, and must not block one.
 *   - The answer belongs to one lecture's drawer, not to the global console.
 *   - The round trip is seconds, not minutes.
 *
 * The consequences are handled here: `vertexLimit` is shared with the pipeline so
 * a burst of questions can't stampede the API, and the call carries its own
 * timeout because there is no Cancel button behind it.
 *
 * ## Why the context is built here and not sent by the page
 *
 * The client says *where* it is — a lecture key, a position, optionally a passage
 * you highlighted. It never supplies the lecture text. Everything the model sees
 * is read back off disk here and capped here, so what leaves the machine is
 * bounded by settings rather than by whatever a page decided to post.
 *
 * ## What this sends to Google
 *
 * Your notes and, when there is one, Panopto's transcript. The notes pipeline
 * already sends the recording itself, so this is not a new exposure — but a
 * button that fires on a text selection makes it easy to send something without
 * having thought about it, which is why the settings say so plainly.
 */

import fs from "node:fs";
import { CONFIG } from "../../config.js";
import { generateChat } from "../gemini/vertexGenerate.js";
import { vertexLimit, resolveProjectOrEmpty } from "../gemini/vertexClient.js";
import { captionsPath } from "../panopto/captions.js";
import { listLectures, readNotes } from "./library.js";
import { log } from "../utils/logger.js";

/** Caps on anything the client supplies. Generous, but finite. */
const MAX_QUESTION_CHARS = 2_000;
const MAX_SELECTION_CHARS = 6_000;
const MAX_HISTORY_TURNS = 20;

export interface ExplainTurn {
  role: "user" | "model";
  text: string;
}

export interface ExplainRequest {
  key?: unknown;
  atSeconds?: unknown;
  question?: unknown;
  selection?: unknown;
  history?: unknown;
  /**
   * Send the whole notes file with this one turn.
   *
   * A per-turn flag rather than a setting, and the page arms it one press at a
   * time. Sending 25 KB with every question is slow, dear, and buries what you
   * asked about among everything you didn't — but a question that genuinely
   * spans the lecture ("how does this connect to the first half?") needs it.
   *
   * Note what it does *not* do: the material rides in the system instruction,
   * which is rebuilt every turn, so a follow-up inherits the model's answer and
   * not the document behind it.
   */
  whole?: unknown;
}

export interface ExplainResult {
  answer: string;
  /**
   * The user turn as it was actually put to the model.
   *
   * Returned so the page can store what was asked rather than its own paraphrase
   * of it: the history posted with the next turn is then exactly the conversation
   * the model had, not a slightly different one.
   */
  ask: string;
  /** What was actually sent, for the "what did it see?" disclosure in the dock. */
  context: {
    pretty: boolean;
    raw: boolean;
    subtitles: boolean;
    /** The lecture's topics and summary, from the note's frontmatter. */
    overview: boolean;
    whole: boolean;
    chars: number;
  };
}

/** Refused for a reason the user can act on, rather than a 500. */
export class ExplainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplainUnavailableError";
  }
}

// ── Reading the lecture ──────────────────────────────────────────────────────

/** `[MM:SS]` or `[H:MM:SS]` anywhere in a line → seconds. */
function lineTime(line: string): number | null {
  const match = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/.exec(line);
  if (!match) return null;
  const [, a, b, c] = match;
  return c === undefined
    ? Number(a) * 60 + Number(b)
    : Number(a) * 3600 + Number(b) * 60 + Number(c);
}

/** Heading level, or 0 for a line that isn't one. */
function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1].length : 0;
}

/** Markdown with its YAML frontmatter removed — it's metadata, not content. */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  return end === -1 ? markdown : markdown.slice(markdown.indexOf("\n", end + 1) + 1);
}

export interface Overview {
  topics: string[];
  summary: string;
}

/** `key: "value"` → value, with the quotes off. */
function unquote(value: string): string {
  const trimmed = value.trim();
  return /^".*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/**
 * The topics and summary out of a note's frontmatter.
 *
 * Worth its own few lines rather than a YAML dependency: this frontmatter is
 * written by our own pipeline, so the shape is known — one-line scalars and a
 * `topics:` list of `  - "…"` — and a parser that only understands that can't be
 * surprised by a construct we never emit.
 *
 * The point of sending it is orientation. Everything else in the context is a
 * window a few minutes wide, so without this the model knows what is being said
 * and not what lecture it is in; "how does this connect to the rest?" is a
 * question it then can't answer even though the notes file says so at the top.
 */
export function readOverview(markdown: string): Overview {
  const empty: Overview = { topics: [], summary: "" };
  if (!markdown.startsWith("---")) return empty;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return empty;

  const lines = markdown.slice(3, end).split("\n");
  const overview: Overview = { topics: [], summary: "" };
  let inTopics = false;

  for (const line of lines) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (inTopics && item) {
      const topic = unquote(item[1]);
      if (topic) overview.topics.push(topic);
      continue;
    }
    inTopics = false;

    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (key === "topics") { inTopics = value.trim() === ""; continue; }
    if (key === "summary") overview.summary = unquote(value);
  }

  return overview;
}

/** Used when a caller doesn't say; the real value is CONFIG.explain.contextChars. */
const DEFAULT_SLICE_CHARS = 1_400;

/**
 * Line indices of the headings on either side of a position.
 *
 * Blocks, not subtrees. A section's subtree is the wrong unit to grow from: the
 * whole document sits under one `#` title, so "expand to the enclosing section"
 * goes from four lines to the entire file in a single step. A block — one
 * heading and the lines until the next heading of any level — is a uniform
 * mouthful, and the heading ancestry puts it back in context afterwards.
 */
function blockStart(lines: string[], index: number): number {
  let start = Math.max(0, Math.min(index, lines.length - 1));
  while (start > 0 && headingLevel(lines[start]) === 0) start--;
  return start;
}

function nextHeading(lines: string[], after: number): number {
  for (let i = after + 1; i < lines.length; i++) {
    if (headingLevel(lines[i]) > 0) return i;
  }
  return lines.length;
}

function previousHeading(lines: string[], before: number): number {
  for (let i = before - 1; i > 0; i--) {
    if (headingLevel(lines[i]) > 0) return i;
  }
  return 0;
}

/**
 * The part of a notes file that covers a given moment, with the headings above it.
 *
 * Timestamps in these files mark where a point was made, and most lines don't
 * carry one — the model stamps a heading and then writes bullets under it — so a
 * line's time is the last one at or above it. From the line that covers
 * `atSeconds`, the slice takes that whole section *and the one before it*, grows
 * outwards a section at a time until it is substantial enough to answer from,
 * and is prefixed with the heading ancestry so "### Two-bit saturating counters"
 * arrives under the "## Branch prediction" it belongs to rather than floating
 * free.
 *
 * `minChars` is how much has to be reached before the growing stops. It rounds
 * outwards to whole sections rather than cutting one off mid-sentence, so the
 * result usually runs somewhat over the number asked for.
 *
 * Returns "" when the file has no timestamps at all to locate anything by.
 */
export function sliceAround(
  markdown: string,
  atSeconds: number,
  minChars: number = DEFAULT_SLICE_CHARS,
): string {
  const lines = stripFrontmatter(markdown).split("\n");

  const stamps: (number | null)[] = lines.map(lineTime);

  /**
   * Each line's time, inherited from the last stamp above it.
   *
   * Headings are the exception, and it matters: a heading introduces what
   * follows, so an unstamped one takes the time of the *next* stamped line
   * rather than the last. Carrying the previous time into it made the heading
   * look like part of the passage above, which dragged the whole of the next
   * section into every slice that ended at one. The player's stampTimes() takes
   * the same view, for the same reason.
   */
  const times: (number | null)[] = [];
  let carry: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const own = stamps[i];
    if (own !== null) { carry = own; times.push(own); continue; }
    if (headingLevel(lines[i]) > 0) {
      times.push(stamps.slice(i + 1).find((t) => t !== null) ?? null);
      continue;
    }
    times.push(carry);
  }
  if (!times.some((t) => t !== null)) return "";

  // The stamped line closest to the moment without overshooting it — not the
  // *last* such line. These files are mostly in order but not reliably: a single
  // back-reference near the end ("as we saw at [12:30]") is enough to make "the
  // last line whose time has been reached" the bottom of the document, which is
  // how a passage in the middle of a lecture ends up explained with the notes
  // from its final minutes.
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = stamps[i];
    if (t === null || t > atSeconds) continue;
    if (anchor === -1 || t > stamps[anchor]!) anchor = i;
  }
  // Before the first timestamp there is nothing to point at, so that reads as
  // the top of the document.
  if (anchor === -1) anchor = 0;

  // Everything that timestamp governs, not just the line carrying it: the model
  // stamps a point and then writes several lines under it, and the one the
  // reader highlighted is usually one of those.
  let runEnd = anchor + 1;
  while (runEnd < lines.length && times[runEnd] === times[anchor]) runEnd++;

  let start = blockStart(lines, anchor);
  let end = nextHeading(lines, start);
  while (end < runEnd) end = nextHeading(lines, end);

  // The block before, always — never mind the size budget.
  //
  // A lecturer sets something up and then makes the point, so the sentence that
  // explains a passage is very often in the passage before it. Growing backwards
  // only when the slice is too small meant a section that was big enough on its
  // own arrived with no lead-in at all, which is exactly the case where the
  // model has plenty to read and still can't see what it follows from.
  const leadIn = start > 0;
  if (leadIn) start = previousHeading(lines, start);

  const measure = () => lines.slice(start, end).join("\n").trim().length;

  // Then alternate. Forwards first when the lead-in has already been taken, so
  // the window stays balanced around the passage rather than trailing behind it.
  let back = !leadIn;
  while (measure() < minChars && (start > 0 || end < lines.length)) {
    if (back && start > 0) start = previousHeading(lines, start);
    else if (end < lines.length) end = nextHeading(lines, end);
    else if (start > 0) start = previousHeading(lines, start);
    else break;
    back = !back;
  }

  const ancestry: string[] = [];
  let want = headingLevel(lines[start]) || 6;
  for (let i = start - 1; i >= 0 && want > 1; i--) {
    const h = headingLevel(lines[i]);
    if (h > 0 && h < want) { ancestry.unshift(lines[i]); want = h; }
  }

  return [...ancestry, ...lines.slice(start, end)].join("\n").trim();
}

/** One WebVTT cue. */
interface Cue { start: number; text: string }

/** `00:01:29.090` → seconds. */
function vttTime(stamp: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(stamp.trim());
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at === -1) continue;
    const start = vttTime(lines[at].split("-->")[0]);
    if (start === null) continue;
    const text = lines.slice(at + 1).join(" ").trim();
    if (text) cues.push({ start, text });
  }
  return cues;
}

function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h > 0 ? `${h}:${rest}` : rest;
}

/**
 * The last N cues that have already been spoken by `atSeconds`.
 *
 * `atSeconds` is in the *recording's* clock, and so are the times this prints —
 * which for a lecture Panopto trimmed at the front is not the clock its
 * transcript is written in. `offsetSeconds` is the difference, and it is applied
 * to both ends: it picks the right cues, and it labels them with times that
 * match the notes in the same prompt and the clock the student is looking at.
 *
 * Everything Explain sends is in the recording's clock. Highlights is the other
 * way round for a reason — see buildHighlights.
 */
export function transcriptWindow(
  vtt: string,
  atSeconds: number,
  lines: number,
  offsetSeconds = 0,
): string {
  const cues = parseVtt(vtt).filter((c) => c.start + offsetSeconds <= atSeconds);
  return cues
    .slice(-Math.max(1, lines))
    .map((c) => `[${clockText(c.start + offsetSeconds)}] ${c.text}`)
    .join("\n");
}

// ── Assembling the prompt ────────────────────────────────────────────────────

function section(title: string, body: string): string {
  return body.trim().length === 0 ? "" : `\n\n## ${title}\n\n${body.trim()}`;
}

/**
 * The standing instructions for one question: how to answer, and the lecture to
 * answer from.
 *
 * A system instruction rather than the first turn of the conversation, so it can
 * be rebuilt from scratch on every turn. A follow-up asked after you've scrubbed
 * somewhere else is then answered about where you are now, and the conversation
 * itself stays a plain sequence of questions and answers with no context wedged
 * into the middle of it.
 */
export function buildContext(key: string, atSeconds: number, wholeDocument = false): {
  instruction: string;
  used: ExplainResult["context"];
} {
  const entry = listLectures().find((e) => e.key === key);
  if (!entry) throw new ExplainUnavailableError("That lecture isn't in the library any more.");

  const cfg = CONFIG.explain;
  const used = {
    pretty: false, raw: false, subtitles: false, overview: false,
    whole: wholeDocument, chars: 0,
  };

  let body =
    `The student is watching "${entry.title}" (${entry.courseCode}), ` +
    `paused at ${clockText(atSeconds)}.`;

  const take = (markdown: string): string =>
    wholeDocument
      ? stripFrontmatter(markdown).trim()
      : sliceAround(markdown, atSeconds, cfg.contextChars);

  const pretty = cfg.include.pretty ? readNotes(key, "pretty") : null;
  const raw = cfg.include.raw ? readNotes(key, "raw") : null;

  // First, because it is the only thing here that describes the lecture as a
  // whole. Everything below is a window a few minutes wide, so without this the
  // model knows what is being said and not what lecture it is in — and "how does
  // this connect to the rest?" becomes unanswerable from a file that says so at
  // the top. A few hundred characters, and it comes free with notes already
  // being read. Pretty first: the prettifier rewrites the summary, and its
  // version is the better one.
  const overview = readOverview(pretty?.content ?? raw?.content ?? "");
  if (overview.topics.length > 0 || overview.summary) {
    const lines = [
      overview.topics.length > 0 ? `Topics: ${overview.topics.join(", ")}` : "",
      overview.summary,
    ].filter(Boolean);
    body += section("What this lecture covers, as a whole", lines.join("\n\n"));
    used.overview = true;
  }

  if (pretty) {
    const slice = take(pretty.content);
    if (slice) { body += section("Notes for this part of the lecture", slice); used.pretty = true; }
  }

  if (raw) {
    const slice = take(raw.content);
    if (slice) { body += section("The unedited notes for the same part", slice); used.raw = true; }
  }

  if (cfg.include.subtitles && entry.id) {
    const file = captionsPath(entry.id);
    let vtt = "";
    try {
      if (file) vtt = fs.readFileSync(file, "utf-8");
    } catch {
      // No transcript cached. Nothing to add, and nothing to report — the answer
      // is still perfectly good from the notes alone.
    }
    // The cached transcript is Panopto's own, cut to a recording they trimmed at
    // the front while the download kept it, so its clock can start minutes after
    // the file's. Handed over as-is, the model gets notes about one moment and
    // speech from another, and labels its answer with times the student cannot
    // find. The offset moves both, so this whole prompt is in one clock: the
    // recording's, which is the one on screen.
    const window = vtt
      ? transcriptWindow(vtt, atSeconds, cfg.subtitleLines, entry.captionOffset)
      : "";
    if (window) {
      body += section("What the lecturer was actually saying, leading up to this moment", window);
      used.subtitles = true;
    }
  }

  // The backstop, not a dial. Trimmed from the front so the transcript window —
  // the closest thing to "what was just said" — is the last thing to go.
  if (body.length > cfg.maxContextChars) {
    body = `[earlier material trimmed]\n\n${body.slice(body.length - cfg.maxContextChars)}`;
  }
  used.chars = body.length;

  return { instruction: `${CONFIG.prompts.explain.trim()}\n\n# The lecture\n\n${body}`, used };
}

// ── The request ──────────────────────────────────────────────────────────────

function text(value: unknown, cap: number): string {
  return typeof value === "string" ? value.trim().slice(0, cap) : "";
}

function readHistory(value: unknown): ExplainTurn[] {
  if (!Array.isArray(value)) return [];
  // The tail, not the head: a long conversation drops its oldest turns rather
  // than its most recent, which are the ones a follow-up depends on.
  return value
    .slice(-MAX_HISTORY_TURNS)
    .filter((t): t is { role: string; text: string } =>
      typeof t === "object" && t !== null && typeof (t as { text?: unknown }).text === "string")
    .map((t) => ({
      role: t.role === "model" ? ("model" as const) : ("user" as const),
      text: t.text.slice(0, MAX_SELECTION_CHARS),
    }))
    .filter((t) => t.text.trim().length > 0);
}

/**
 * Answer one question about a lecture.
 *
 * Throws ExplainUnavailableError for anything the user can fix — no project, the
 * feature switched off, a lecture that's gone — so the route can answer 503 with
 * something worth reading rather than a stack trace.
 */
export async function explain(request: ExplainRequest): Promise<ExplainResult> {
  if (!CONFIG.explain.enabled) {
    throw new ExplainUnavailableError(
      "Explain is switched off in Settings → Explain.",
    );
  }
  if (resolveProjectOrEmpty().length === 0) {
    throw new ExplainUnavailableError(
      "Explain needs a Google Cloud project — it calls Vertex directly, because the " +
        "browser provider takes minutes per answer and holds the pipeline lock while it " +
        "does. Set one in Settings → Google Cloud.",
    );
  }

  const key = text(request.key, 400);
  if (!key) throw new ExplainUnavailableError("No lecture given.");

  const atSeconds = Math.max(0, Math.floor(Number(request.atSeconds) || 0));
  const selection = text(request.selection, MAX_SELECTION_CHARS);
  const question = text(request.question, MAX_QUESTION_CHARS);
  const history = readHistory(request.history);

  // What the turn actually asks. A selection *is* the question — you highlighted
  // it to point at it — so it goes in the turn rather than the context, which
  // also means a follow-up can still see what the conversation was about.
  const ask = selection
    ? `Explain this, from the notes at ${clockText(atSeconds)}:\n\n${selection}${question ? `\n\n${question}` : ""}`
    : question || `Explain what is being covered at ${clockText(atSeconds)}.`;

  const { instruction, used } = buildContext(key, atSeconds, request.whole === true);

  const contents = [...history, { role: "user" as const, text: ask }].map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text }],
  }));

  log.debug(`explain: ${used.chars} chars of context, ${contents.length} turn(s)`);

  const answer = await vertexLimit(() =>
    generateChat({
      model: CONFIG.explain.model,
      contents,
      systemInstruction: instruction,
      maxOutputTokens: CONFIG.explain.maxOutputTokens,
      thinkingLevel: CONFIG.explain.thinkingLevel,
      timeoutMs: CONFIG.explain.timeoutSeconds * 1000,
    }),
  );

  if (!answer) throw new Error("The model returned nothing.");
  return { answer, ask, context: used };
}

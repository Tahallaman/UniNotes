/**
 * Highlights — the lecture cut down to the parts worth watching.
 *
 * ## The shape of it
 *
 * One model call reads the transcript and the raw notes and returns *every* span
 * worth watching, each scored 1–5 for importance — typically two or three times
 * more material than anyone wants to watch. What you actually watch is then
 * chosen from those candidates by preset, here, with no model involved.
 *
 * That split is the whole design. The expensive judgement (what is worth
 * watching) is made once and saved; the cheap one (how long have I got) is made
 * as often as you like, instantly and offline. Skim, Highlights and Deep are the
 * same call read three ways.
 *
 * ## Why the file is written beside the notes
 *
 * Not an optimisation — load-bearing. The transcript this is built from lives in
 * the video cache, which is emptied every time the panel starts *and* stops. An
 * unsaved reel would die with the session that made it and cost another call the
 * next morning. Beside the notes it outlives the video, and it is readable by a
 * human who wants to know what the model thought without watching anything.
 *
 * ## Why the times can be trusted
 *
 * The model is only allowed to name times that appear in the transcript it was
 * given, and every boundary it returns is then snapped back to a real cue
 * boundary here. A model that invents 07:41 gets the cue that actually starts at
 * 07:38, so a span can't open mid-word. Everything else is validated too: order,
 * overlap, length, and the video's own length as the outer bound.
 *
 * ## What this sends to Google
 *
 * The whole transcript and the whole raw notes for one lecture — considerably
 * more than Explain sends for one question, and the settings say so. It happens
 * once per lecture, when you press the button.
 */

import fs from "node:fs";
import path from "node:path";
import { generateChat } from "../gemini/vertexGenerate.js";
import { vertexLimit, resolveProjectOrEmpty } from "../gemini/vertexClient.js";
import { captionsPath, parseVtt } from "../panopto/captions.js";
import { listLectures, readNotes } from "./library.js";
import { readOverview } from "./explain.js";
import { effectiveConfig } from "./effective.js";
import { log } from "../utils/logger.js";

/** One span of lecture worth watching. */
export interface Segment {
  /** Seconds, snapped to a cue boundary. */
  start: number;
  end: number;
  /** 1–5, the model's own ranking. What the presets cut by. */
  weight: number;
  /** One line saying what happens in it. */
  why: string;
}

export interface Reel {
  /** ISO date the call was made. Shown in the panel, so a stale reel is visible. */
  madeAt: string;
  model: string;
  /** The extra instruction it was built with, if any. Empty for a plain build. */
  steer: string;
  /** The recording's length in seconds — what the preset shares are shares of. */
  lectureSeconds: number;
  /** Every candidate, in time order. The presets choose from these. */
  segments: Segment[];
}

export type PresetName = "skim" | "highlights" | "deep";

export interface Pick {
  /** Total run time of the chosen spans, in seconds. */
  seconds: number;
  segments: Segment[];
}

export interface ReelPayload {
  reel: Reel | null;
  picks: Record<PresetName, Pick>;
  /** Why there is no reel and no way to build one, or "" when there is. */
  unavailable: string;
}

/** Refused for a reason the user can act on, rather than a 500. */
export class HighlightsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HighlightsUnavailableError";
  }
}

const FILENAME = "highlights.json";
const MAX_SEGMENTS = 80;
const MAX_STEER_CHARS = 500;

// ── Times ────────────────────────────────────────────────────────────────────

function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h > 0 ? `${h}:${rest}` : rest;
}

/**
 * A time from the model, in whatever form it felt like.
 *
 * "12:34" is what it was asked for and what it almost always gives; a bare
 * number of seconds is the other thing models do when a schema mentions
 * seconds. Both are cheap to accept and the alternative is throwing away a
 * perfectly good span over its formatting.
 */
function readTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  const clock = /^(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/.exec(text);
  if (clock) {
    const [, h, m, s] = clock;
    return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
  }
  const plain = Number(text);
  return Number.isFinite(plain) && plain >= 0 ? plain : null;
}

// ── What gets sent ───────────────────────────────────────────────────────────

/** One subtitle cue — structurally what src/panopto/captions.ts parses. */
export interface Cue { start: number; end: number; text: string }

/**
 * The transcript as timestamped paragraphs rather than as breath-length cues.
 *
 * An auto-transcript breaks on breath — a cue every two or three seconds — so an
 * hour arrives as a thousand fragments. That is expensive to send and harder to
 * read than the same words in paragraphs, and it buys nothing: the model's
 * choice of boundary is snapped back to a real cue afterwards, so merging costs
 * no precision at all. Only the anchors get coarser, and ten seconds is far
 * denser than the spans being chosen.
 */
function blocks(cues: Cue[], seconds: number): string {
  const out: string[] = [];
  let start = -1;
  let text: string[] = [];

  const flush = () => {
    if (start >= 0 && text.length > 0) out.push(`[${clockText(start)}] ${text.join(" ")}`);
    start = -1;
    text = [];
  };

  for (const cue of cues) {
    if (start < 0) start = cue.start;
    text.push(cue.text);
    if (cue.end - start >= seconds) flush();
  }
  flush();
  return out.join("\n");
}

function section(title: string, body: string): string {
  return body.trim().length === 0 ? "" : `\n\n## ${title}\n\n${body.trim()}`;
}

/** Markdown with its YAML frontmatter removed — it's metadata, not content. */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  return end === -1 ? markdown : markdown.slice(markdown.indexOf("\n", end + 1) + 1);
}

// ── Reading and writing the file ─────────────────────────────────────────────

function reelPath(key: string): string | null {
  const entry = listLectures().find((e) => e.key === key);
  return entry?.lectureDir ? path.join(entry.lectureDir, FILENAME) : null;
}

export function readReel(key: string): Reel | null {
  const file = reelPath(key);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Reel>;
    if (!Array.isArray(parsed.segments)) return null;
    return {
      madeAt: String(parsed.madeAt ?? ""),
      model: String(parsed.model ?? ""),
      steer: String(parsed.steer ?? ""),
      lectureSeconds: Number(parsed.lectureSeconds) || 0,
      segments: parsed.segments as Segment[],
    };
  } catch {
    // Missing is the ordinary case; corrupt is rare and equivalent — you press
    // the button and get a new one.
    return null;
  }
}

function writeReel(key: string, reel: Reel): void {
  const file = reelPath(key);
  if (!file) throw new HighlightsUnavailableError("This lecture has no folder to save highlights in.");
  fs.writeFileSync(file, `${JSON.stringify(reel, null, 2)}\n`, "utf-8");
}

// ── Choosing what to watch ───────────────────────────────────────────────────

/**
 * Cut the candidates down to one preset's worth.
 *
 * Two rules, and the pairing is the point. The **share** is a ceiling on run
 * time, which adapts where a fixed number of minutes cannot — ten minutes is
 * most of a 25-minute lab and nothing of a two-hour lecture. The **floor** is
 * what stops a preset padding itself out to fill that ceiling.
 *
 * So the share is never a quota: a lecture that was mostly admin yields a
 * two-minute Deep, because there were only two minutes' worth in it, and that is
 * the correct answer rather than a failure to find more.
 *
 * Best-fit rather than first-fit — a span that doesn't fit is skipped and the
 * next one considered, so one long segment near the budget can't lock out three
 * good short ones. Ties break towards the earlier span, so a reel is stable
 * between builds rather than reshuffling on equal scores.
 */
export function pick(
  reel: Reel,
  preset: PresetName,
  // Widened from what config.ts infers, which is the literal 10/25/45 it was
  // written with — a parameter typed that narrowly accepts only the defaults.
  presets: Record<PresetName, { minWeight: number; share: number }> =
    effectiveConfig().highlights.presets,
): Pick {
  const { minWeight, share } = presets[preset];
  const budget = Math.max(0, reel.lectureSeconds * (share / 100));

  const ranked = reel.segments
    .filter((s) => s.weight >= minWeight)
    .slice()
    .sort((a, b) => (b.weight - a.weight) || (a.start - b.start));

  const chosen: Segment[] = [];
  let total = 0;
  for (const segment of ranked) {
    const length = segment.end - segment.start;
    if (total + length > budget) continue;
    chosen.push(segment);
    total += length;
  }

  chosen.sort((a, b) => a.start - b.start);
  return { seconds: Math.round(total), segments: chosen };
}

function payload(reel: Reel | null, unavailable = ""): ReelPayload {
  const empty: Pick = { seconds: 0, segments: [] };
  // Read once for all three, and from the *effective* config rather than this
  // process's frozen CONFIG — see src/gui/effective.ts. Retuning a preset in
  // Settings then changes what plays on the next press, not after a restart.
  const presets = effectiveConfig().highlights.presets;
  return {
    reel,
    picks: reel
      ? {
          skim: pick(reel, "skim", presets),
          highlights: pick(reel, "highlights", presets),
          deep: pick(reel, "deep", presets),
        }
      : { skim: empty, highlights: empty, deep: empty },
    unavailable,
  };
}

/**
 * The saved reel for a lecture, already cut three ways.
 *
 * All three picks are computed here rather than on demand so that switching
 * preset in the panel is a local array swap: the rule lives in one place, and
 * the page never has to reimplement it to feel instant.
 */
export function getHighlights(key: string): ReelPayload {
  return payload(readReel(key), whyNot(key));
}

/** Why a reel can't be built for this lecture, or "" if it can. */
function whyNot(key: string): string {
  if (!effectiveConfig().highlights.enabled) return "Highlights is switched off in Settings → Highlights.";
  if (resolveProjectOrEmpty().length === 0) {
    return "Highlights needs a Google Cloud project — it calls Vertex directly. Set one in Settings → Google Cloud.";
  }
  const entry = listLectures().find((e) => e.key === key);
  if (!entry) return "That lecture isn't in the library any more.";
  if (!entry.lectureDir) return "This lecture has no folder to save highlights in.";
  if (!entry.id || !hasTranscript(entry.id)) {
    return "Highlights needs this lecture's transcript, which arrives with the video. Fetch the recording first.";
  }
  return "";
}

function hasTranscript(id: string): boolean {
  const file = captionsPath(id);
  if (!file) return false;
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// ── Building one ─────────────────────────────────────────────────────────────

/**
 * Pull the JSON array out of whatever the model actually returned.
 *
 * It is asked for bare JSON and usually obliges. A fence or a line of preamble
 * is the ordinary failure and not worth a round trip to correct, so the first
 * bracketed array in the reply is taken instead.
 */
function readJsonArray(reply: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const body = fenced ? fenced[1] : reply;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("The model didn't return a list of highlights.");
  return JSON.parse(body.slice(start, end + 1)) as unknown[];
}

/**
 * Turn what the model said into spans that can actually be played.
 *
 * Every boundary is snapped to a real cue: a start moves back to the cue
 * covering it, an end forward to the end of the cue covering it, so a span never
 * opens or closes mid-word however loosely the model quoted the time. The lead-in
 * is applied before snapping for the same reason the player's click lead-in
 * exists — landing exactly on the first word puts you a beat after the sentence
 * that set it up.
 *
 * Then the ordinary hygiene: inside the recording, long enough to be a span,
 * in order, and not overlapping. Overlaps keep the stronger of the two, because
 * a merged span would inherit a reason describing only half of itself.
 */
export function clean(
  raw: unknown[],
  cues: Cue[],
  lectureSeconds: number,
  // Narrowed to what it actually reads, so a test can hand it two numbers
  // rather than a whole config.
  cfg: { leadInSeconds: number; minSegmentSeconds: number } = effectiveConfig().highlights,
): Segment[] {
  const starts = cues.map((c) => c.start);

  /** The start of the cue covering `t`, or `t` itself when there are no cues. */
  const snapStart = (t: number): number => {
    let best = t;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= t) best = starts[i];
      else break;
    }
    return best;
  };

  /** The end of the cue covering `t`, so a span closes on a finished sentence. */
  const snapEnd = (t: number): number => {
    let best = t;
    for (const cue of cues) {
      if (cue.end >= t) { best = Math.max(t, cue.end); break; }
    }
    return best;
  };

  const segments: Segment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;

    const from = readTime(row.start);
    const to = readTime(row.end);
    if (from === null || to === null || to <= from) continue;

    const why = String(row.why ?? "").trim().slice(0, 300);
    if (!why) continue;

    const weight = Math.min(5, Math.max(1, Math.round(Number(row.weight) || 3)));

    let start = snapStart(Math.max(0, from - cfg.leadInSeconds));
    let end = snapEnd(to);
    if (lectureSeconds > 0) {
      start = Math.min(start, lectureSeconds);
      end = Math.min(end, lectureSeconds);
    }
    if (end - start < cfg.minSegmentSeconds) continue;

    segments.push({ start, end, weight, why });
  }

  segments.sort((a, b) => a.start - b.start);

  const kept: Segment[] = [];
  for (const segment of segments) {
    const last = kept[kept.length - 1];
    if (!last || segment.start >= last.end) { kept.push(segment); continue; }
    // Overlapping. Keep the one that matters more; a merge would leave a span
    // whose reason describes only part of it.
    if (segment.weight > last.weight) kept[kept.length - 1] = segment;
  }

  return kept.slice(0, MAX_SEGMENTS);
}

export interface BuildRequest {
  key?: unknown;
  /** An instruction for this build — "more on the derivations, skip the demo". */
  steer?: unknown;
}

/**
 * Build a reel for one lecture, and save it.
 *
 * Throws HighlightsUnavailableError for anything the user can act on, so the
 * route can answer 503 with something worth reading rather than a stack trace.
 */
export async function buildHighlights(request: BuildRequest): Promise<ReelPayload> {
  const key = typeof request.key === "string" ? request.key.slice(0, 400) : "";
  const steer = typeof request.steer === "string"
    ? request.steer.trim().replace(/\s+/g, " ").slice(0, MAX_STEER_CHARS)
    : "";

  const refusal = whyNot(key);
  if (refusal) throw new HighlightsUnavailableError(refusal);

  const entry = listLectures().find((e) => e.key === key)!;
  // Effective, not this process's frozen CONFIG: the panel is long-lived, and a
  // prompt or a model changed in Settings has to apply to the next press.
  const settings = effectiveConfig();
  const cfg = settings.highlights;

  const vtt = fs.readFileSync(captionsPath(entry.id!)!, "utf-8");
  const cues = parseVtt(vtt);
  if (cues.length === 0) throw new HighlightsUnavailableError("That transcript has no usable cues in it.");

  // The video's own length when we know it, the transcript's when we don't. It
  // is what the preset shares are shares of, so a wrong one skews every preset —
  // and the last cue ending is a good floor even for a recording that runs on
  // past the talking.
  const lectureSeconds = Math.max(
    Number(entry.videoSeconds) || 0,
    cues[cues.length - 1].end,
  );

  const notes = readNotes(key, "raw") ?? readNotes(key, "pretty");
  const overview = readOverview(notes?.content ?? "");

  let body =
    `Lecture: "${entry.title}" (${entry.courseCode}). ` +
    `The recording runs ${clockText(lectureSeconds)}.`;

  if (overview.topics.length > 0 || overview.summary) {
    body += section(
      "What this lecture covers, as a whole",
      [overview.topics.length > 0 ? `Topics: ${overview.topics.join(", ")}` : "", overview.summary]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  // The notes first, then the transcript. The notes carry judgement and
  // structure but thinned timestamps; the transcript carries every word and
  // exact times but no judgement. Reading the notes first is what lets the model
  // find the meat in them and then pin it to a real time below.
  if (notes) body += section("The notes for this lecture", stripFrontmatter(notes.content));
  body += section(
    "The transcript. Every start and end you give must be a time that appears here",
    blocks(cues, cfg.blockSeconds),
  );
  if (steer) body += section("What this student has asked for in particular", steer);

  // Trimmed from the *end*, so a very long recording loses its last stretch
  // rather than its first. Losing the front would be worse: the opening of a
  // lecture is where the framing is, and a reel that skips it is wrong in a way
  // a reel that stops early is not.
  if (body.length > cfg.maxContextChars) {
    body = `${body.slice(0, cfg.maxContextChars)}\n\n[the rest of this lecture was too long to send]`;
  }

  log.info(`highlights: ${entry.title} — ${body.length} chars, ${cues.length} cues`);

  const reply = await vertexLimit(() =>
    generateChat({
      model: cfg.model,
      contents: [{ role: "user", parts: [{ text: "Choose the highlights for this lecture." }] }],
      systemInstruction: `${settings.prompts.highlights.trim()}\n\n# The lecture\n\n${body}`,
      maxOutputTokens: cfg.maxOutputTokens,
      thinkingLevel: cfg.thinkingLevel,
      timeoutMs: cfg.timeoutSeconds * 1000,
    }),
  );

  if (!reply) throw new Error("The model returned nothing.");

  const segments = clean(readJsonArray(reply), cues, lectureSeconds, cfg);
  if (segments.length === 0) {
    throw new HighlightsUnavailableError(
      "Nothing came back that could be played — no usable spans in the reply. Worth trying again.",
    );
  }

  const reel: Reel = {
    madeAt: new Date().toISOString(),
    model: cfg.model,
    steer,
    lectureSeconds,
    segments,
  };
  writeReel(key, reel);
  log.info(`highlights: ${segments.length} spans saved for ${entry.title}`);

  return payload(reel);
}

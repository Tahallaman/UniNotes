/**
 * Highlights — the lecture cut down to the parts worth watching.
 *
 * ## Three reels, three calls
 *
 * Skim, Highlights and Deep are each built by their own request, for their own
 * shape: many very short cuts, a middle, and many longer ones. Each is saved
 * separately, so a lecture can have one, two or all three.
 *
 * The first version did the opposite — one pass scored every span 1–5 and the
 * three presets cut those candidates locally, which made switching free. It was
 * the wrong trade. A reel built to be cut three ways is built for none of them,
 * and what came back was a set of medium-length spans that suited the middle
 * preset and neither end. A skim and a deep pass are different editing jobs, not
 * two lengths of the same one. The price is that changing your mind costs a
 * call, which is why the button opens the panel rather than building on press.
 *
 * The scores survive that change with a narrower job: if a reel comes back
 * longer than it was asked for, the weakest spans are dropped until it fits.
 *
 * ## What decides what gets cut
 *
 * The notes and the transcript do different jobs, and the prompt says so. The
 * notes were written from this recording and already name what mattered in it;
 * they are the list of things to look for. The transcript is where each of those
 * things was said, and the only source of times. Working from our own notes
 * rather than from the model's idea of the subject is the same anti-invention
 * principle the notes prompts are built on.
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
  /** 1–5, the model's own ranking. Only used to trim an over-long reel. */
  weight: number;
  /** One line saying what happens in it. */
  why: string;
}

export type PresetName = "skim" | "highlights" | "deep";

/** How long one reel's spans should be, and how much they should add up to. */
export interface Preset {
  /** Target run time, as a percentage of the lecture. */
  share: number;
  minSeconds: number;
  maxSeconds: number;
  /** The middle of the band the model is asked to aim for. */
  aimSeconds: number;
  /** How many cuts this reel is recommended to have. See `plan`. */
  minSpans: number;
}

export interface Reel {
  preset: PresetName;
  /** ISO date the call was made. Shown in the panel, so a stale reel is visible. */
  madeAt: string;
  model: string;
  /** The extra instruction it was built with, if any. Empty for a plain build. */
  steer: string;
  /** The recording's spoken length in seconds — what `share` is a share of. */
  lectureSeconds: number;
  /** The reel itself, in time order. */
  segments: Segment[];
  /** Total run time of those spans, so the panel needn't add them up. */
  seconds: number;
}

export interface ReelPayload {
  /** One per preset, null until that one has been built. */
  reels: Record<PresetName, Reel | null>;
  /**
   * What each preset means, so the panel can describe the three buttons before
   * any of them exist. Without this they are three words with nothing to
   * distinguish them until after you have paid for a build.
   */
  presets: Record<PresetName, Preset>;
  /** Why no reel can be built, or "" when one can. */
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
/** A reel cuts often — an hour can legitimately be fifty or sixty spans. */
const MAX_SEGMENTS = 250;
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

/** One turn of the exchange with the model. Two of them, at most. */
interface Turn { role: "user" | "model"; text: string }

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

const PRESET_NAMES: readonly PresetName[] = ["skim", "highlights", "deep"];

const NO_REELS: Record<PresetName, Reel | null> = { skim: null, highlights: null, deep: null };

/**
 * Every reel saved for a lecture — one file holding up to three.
 *
 * One file rather than three, because they are one thing about one lecture and
 * a folder with `highlights.skim.json` beside `highlights.deep.json` invites
 * you to wonder which is authoritative. A shape it doesn't recognise reads as
 * nothing at all, which is also what the first version's single-reel file does:
 * that one was cut three ways at read time and can't be reconstructed as three
 * reels, so it is quietly superseded by the next build rather than migrated.
 */
export function readReels(key: string): Record<PresetName, Reel | null> {
  const file = reelPath(key);
  if (!file) return { ...NO_REELS };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { reels?: unknown };
    const saved = (parsed.reels ?? {}) as Record<string, unknown>;
    const reels = { ...NO_REELS };
    for (const name of PRESET_NAMES) {
      const reel = saved[name] as Partial<Reel> | undefined;
      if (!reel || !Array.isArray(reel.segments) || reel.segments.length === 0) continue;
      reels[name] = {
        preset: name,
        madeAt: String(reel.madeAt ?? ""),
        model: String(reel.model ?? ""),
        steer: String(reel.steer ?? ""),
        lectureSeconds: Number(reel.lectureSeconds) || 0,
        segments: reel.segments as Segment[],
        seconds: Number(reel.seconds) || 0,
      };
    }
    return reels;
  } catch {
    // Missing is the ordinary case; corrupt is rare and equivalent — you press
    // a preset and get a new one.
    return { ...NO_REELS };
  }
}

/** Save one reel without disturbing the other two. */
function writeReel(key: string, reel: Reel): void {
  const file = reelPath(key);
  if (!file) throw new HighlightsUnavailableError("This lecture has no folder to save highlights in.");
  const reels = readReels(key);
  reels[reel.preset] = reel;
  fs.writeFileSync(file, `${JSON.stringify({ version: 2, reels }, null, 2)}\n`, "utf-8");
}

// ── Keeping a reel to its size ───────────────────────────────────────────────

/**
 * Drop the weakest spans until the reel fits the time it was asked for.
 *
 * The model is told what to aim for and mostly obliges, so this usually does
 * nothing — but "mostly" is not a property to hand a player. Overshooting is the
 * failure that matters: a Skim that comes back at 30% of the lecture is not a
 * skim, and the student finds out by watching it.
 *
 * By weight ascending, so what goes is what the model itself rated lowest.
 * Undershooting is left alone: a lecture with only five minutes worth keeping
 * gives a five-minute reel, and padding it out to reach a percentage would be
 * inventing value.
 */
/**
 * Stretches of the lecture the reel says nothing about.
 *
 * The measurement behind the second pass. "Cover the whole lecture" is advice a
 * model can believe it has followed while leaving a six-minute hole where the
 * willingness-to-pay methodology was; being handed the hole, by timestamp, is
 * something it can act on — and the transcript for it is already in front of it.
 *
 * The head and tail of a recording are exempt: lectures open with arrival and
 * admin and close with "any questions", and a reel that skips both is right.
 */
export function gaps(
  segments: Segment[],
  lectureSeconds: number,
  maxGapSeconds: number,
): Array<[number, number]> {
  if (segments.length === 0 || maxGapSeconds <= 0) return [];
  const found: Array<[number, number]> = [];
  const edge = Math.min(120, lectureSeconds * 0.05);

  let cursor = edge;
  for (const segment of segments) {
    if (segment.start - cursor > maxGapSeconds) found.push([cursor, segment.start]);
    cursor = Math.max(cursor, segment.end);
  }
  if (lectureSeconds - edge - cursor > maxGapSeconds) found.push([cursor, lectureSeconds - edge]);
  return found;
}

export function trim(
  segments: Segment[],
  budgetSeconds: number,
  /**
   * How long a hole trimming may leave behind. A span whose removal would open
   * a longer one is kept regardless of how weak it is — the reel has to remain a
   * run through the whole lecture, and a percentage is not worth a hole.
   */
  maxGapSeconds = 0,
  lectureSeconds = 0,
  /**
   * The fewest cuts to leave behind. The count is the thing being asked for, so
   * trimming may not undo it: a reel that came back with 56 cuts and was cut to
   * 45 to save ninety seconds has been made worse in the only dimension anyone
   * asked about.
   */
  minKeep = 0,
): Segment[] {
  const total = (list: Segment[]) => list.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (budgetSeconds <= 0 || total(segments) <= budgetSeconds) return segments;

  // Weakest first, and among equals the longest — dropping one 60-second span
  // beats dropping four 15-second ones, because the cut count is what makes a
  // reel feel like a reel.
  const order = segments
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) =>
      (a.segment.weight - b.segment.weight)
      || ((b.segment.end - b.segment.start) - (a.segment.end - a.segment.start)));

  const dropped = new Set<number>();
  const kept = () => segments.filter((_, index) => !dropped.has(index));
  let running = total(segments);

  for (const { segment, index } of order) {
    if (running <= budgetSeconds) break;
    if (segments.length - dropped.size <= minKeep) break;
    dropped.add(index);
    // Coverage outranks the budget. Put it back if losing it tears a hole in the
    // lecture, and go on to the next candidate instead.
    if (maxGapSeconds > 0 && gaps(kept(), lectureSeconds, maxGapSeconds).length
        > gaps(segments, lectureSeconds, maxGapSeconds).length) {
      dropped.delete(index);
      continue;
    }
    running -= segment.end - segment.start;
  }
  return kept();
}

function payload(reels: Record<PresetName, Reel | null>, unavailable = ""): ReelPayload {
  // From the *effective* config rather than this process's frozen CONFIG — see
  // src/gui/effective.ts. Retuning a preset in Settings then changes what the
  // next build asks for, rather than waiting for a restart.
  return { reels, presets: effectiveConfig().highlights.presets, unavailable };
}

/** Whatever has been built for this lecture so far. Free — no model involved. */
export function getHighlights(key: string): ReelPayload {
  return payload(readReels(key), whyNot(key));
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
export function readJsonArray(reply: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const body = fenced ? fenced[1] : reply;
  const start = body.indexOf("[");
  if (start === -1) throw new Error("The model didn't return a list of highlights.");

  const end = body.lastIndexOf("]");
  if (end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1)) as unknown[];
    } catch {
      // Fall through and salvage. A closing bracket that doesn't parse means
      // damage somewhere in the middle, which the same repair handles.
    }
  }

  /**
   * Salvage a reel that was cut off mid-answer.
   *
   * The budget covers thinking as well as output, so a long lecture can run out
   * of room part-way through the array and return forty perfectly good spans
   * followed by half of a forty-first. Throwing that away means the whole build
   * fails on a lecture that just had a lot in it — the exact case this feature
   * exists for. Everything up to the last complete object is a valid reel; it is
   * simply a shorter one, and the gap check will notice if the tail is missing.
   */
  const lastComplete = body.lastIndexOf("}");
  if (lastComplete > start) {
    try {
      return JSON.parse(`${body.slice(start, lastComplete + 1)}]`) as unknown[];
    } catch {
      // Not repairable — fall through to the error below.
    }
  }
  throw new Error("The model's list of highlights couldn't be read.");
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
  // Narrowed to what it actually reads, so a test can hand it three numbers
  // rather than a whole config.
  cfg: { leadInSeconds: number; minSegmentSeconds: number; maxSeconds?: number } =
    effectiveConfig().highlights,
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
    // Held to this reel's own ceiling, and cut at a cue so it still ends on a
    // finished sentence. A span that ran long was the failure that made these
    // three separate builds in the first place; letting one through here would
    // put it straight back.
    if (cfg.maxSeconds && end - start > cfg.maxSeconds) {
      const limit = start + cfg.maxSeconds;
      const cue = cues.find((c) => c.end >= limit);
      // The nearer boundary of the cue the limit lands in, not always its end.
      // Rounding outwards every time overshot the ceiling by up to a whole cue —
      // an auto-transcript's are six or seven seconds, which turned a 16-second
      // skim cut into a 22-second one and made Skim and Highlights look alike.
      // The cue's own start is a legitimate boundary too, as long as the span
      // that remains is still a span.
      const nearer = cue && cue.start > start && (limit - cue.start) < (cue.end - limit)
        ? cue.start
        : cue?.end;
      const capped = nearer ?? limit;
      end = Math.min(Math.max(capped, start + cfg.minSegmentSeconds), end);
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
  /** Which of the three to build. One request builds exactly one. */
  preset?: unknown;
  /** An instruction for this build — "more on the derivations, skip the demo". */
  steer?: unknown;
}

/**
 * The part of the prompt that differs between the three reels.
 *
 * Built here rather than left in the editable prompt file because it is
 * arithmetic against this lecture's length and this preset's numbers — a
 * settings textarea should not have to be kept in sync with a percentage.
 *
 * The span count is stated outright, not implied. "Cut often" is advice a model
 * can satisfy with twenty spans; "aim for about a hundred and thirty" is not.
 */
/**
 * How many cuts to ask for, and how long each should be.
 *
 * Share ÷ cut length gives a count, but on a shortish lecture that count comes
 * out lower than a reel wants to be — forty cuts still reads as a summary, and
 * the thing that makes a keynote recap feel like one is the sheer number of
 * times it cuts. So the count has a floor, and when the floor is what binds, the
 * cut length is derived back from it rather than left contradicting it: more
 * cuts inside the same total simply means shorter ones.
 *
 * The floor is the preset's own, which is what lets the three differ in length
 * rather than only in the character of the cut. A shared floor made every reel
 * on a 44-minute lecture come out between thirteen and twenty-five minutes,
 * because that is what its number of cuts multiplied by a watchable cut length
 * comes to, whatever share it was given.
 *
 * Clamped to the preset's own band, so a floor can't turn Deep into Skim. Where
 * that clamp bites the reel runs over its share, which is allowed — the share is
 * a soft ceiling and the cut count is the thing being asked for.
 *
 * Shared with the check that decides whether to ask for a second pass, so the
 * two can't drift apart and complain about a number nobody was told.
 */
export function plan(cfg: Preset, lectureSeconds: number): {
  target: number;
  spans: number;
  aimSeconds: number;
} {
  const target = lectureSeconds * (cfg.share / 100);
  const spans = Math.max(cfg.minSpans, Math.round(target / cfg.aimSeconds));
  const aimSeconds = Math.max(cfg.minSeconds, Math.min(cfg.maxSeconds, Math.round(target / spans)));
  return { target, spans, aimSeconds };
}

function brief(preset: PresetName, cfg: Preset, lectureSeconds: number): string {
  const { target, spans, aimSeconds } = plan(cfg, lectureSeconds);
  const minutes = Math.max(1, Math.round(lectureSeconds / 60));

  const character: Record<PresetName, string> = {
    skim: "A fast pass. Very short cuts, one after another, so that watching it "
      + "start to finish tells the whole story of the lecture in a fraction of "
      + "the time. Favour the sentence that states a thing over the sentence "
      + "that explains it — but keep the few short connectives that hold the "
      + "argument together, or it plays as a list of facts.",
    highlights: "The everyday reel. Short and medium cuts, enough of each point "
      + "to land properly, and enough of them that nothing important is missing. "
      + "This is the one someone watches instead of the lecture, so it has to "
      + "stand on its own.",
    deep: "The thorough pass. Still many cuts, but each has room to finish its "
      + "thought — a worked example can keep the step that makes it make sense, "
      + "and an argument can keep its objection as well as its conclusion.",
  };

  return [
    `THE BRIEF FOR THIS REEL: ${preset.toUpperCase()}`,
    "",
    character[preset],
    "",
    `- Around ${spans} spans. Somewhat fewer or somewhat more is fine — what matters is that it is`,
    `  that sort of number rather than a dozen, because the number of times a reel cuts is what`,
    `  makes it a reel rather than a summary. If in doubt, err towards more.`,
    `- Each span ${cfg.minSeconds} to ${cfg.maxSeconds} seconds, and they must AVERAGE about`,
    `  ${aimSeconds} seconds. Not "mostly under the maximum" — averaging ${aimSeconds}.`,
    `- So the whole reel runs about ${clockText(target)}: roughly ${cfg.share}% of this ${minutes}-minute lecture.`,
    "",
    "Before you answer, do this check. Count your spans, and work out their average length. If the",
    `count is well short of ${spans}, you have skipped material — go back through the transcript for it.`,
    `If the average is over ${aimSeconds} seconds, you are keeping the run-up and the trailing-off`,
    "around each point: trim both ends, and where a span covers two separate claims, split it in two.",
    "",
    "Going over the total is worse than going under: spans past it are dropped weakest-first and you",
    "do not get to choose which. Getting the count right is how you keep what you meant to keep.",
  ].join("\n");
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
  const preset = PRESET_NAMES.find((p) => p === request.preset);
  if (!preset) throw new HighlightsUnavailableError("Pick Skim, Highlights or Deep first.");

  const refusal = whyNot(key);
  if (refusal) throw new HighlightsUnavailableError(refusal);

  const entry = listLectures().find((e) => e.key === key)!;
  // Effective, not this process's frozen CONFIG: the panel is long-lived, and a
  // prompt or a model changed in Settings has to apply to the next press.
  const settings = effectiveConfig();
  const cfg = settings.highlights;
  const presetCfg = cfg.presets[preset];

  const vtt = fs.readFileSync(captionsPath(entry.id!)!, "utf-8");
  const cues = parseVtt(vtt);
  if (cues.length === 0) throw new HighlightsUnavailableError("That transcript has no usable cues in it.");

  // The *spoken* length, not the file's, and deliberately so.
  //
  // This is what the preset shares are shares of, and the two numbers differ by
  // more than you would guess: the recording that prompted this runs 59:52 while
  // its transcript ends at 43:52. Sixteen minutes of it is nobody talking —
  // about four at the front, which Panopto trimmed for playback and the download
  // kept (see the player's caption offset), and the rest at the end. Budget
  // against the file and a quarter of the lecture silently becomes a third,
  // spent on spans that can only come from the part where people were talking
  // anyway.
  //
  // Note this is a transcript time and stays one: the offset corrects playback,
  // never the reel, so a lecture aligned after its reel was cut needs no rebuild.
  const lectureSeconds = cues[cues.length - 1].end;

  const notes = readNotes(key, "raw") ?? readNotes(key, "pretty");
  const overview = readOverview(notes?.content ?? "");

  let body =
    `Lecture: "${entry.title}" (${entry.courseCode}). ` +
    `The recording runs ${clockText(lectureSeconds)}.` +
    section("The brief for this reel", brief(preset, presetCfg, lectureSeconds));

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
  // Last, and repeated from the top of the instruction: the length band and the
  // span count are the two things that decide whether this comes out a reel or a
  // table of contents, and the end of a long prompt is where attention is.
  body += section("The brief, again", brief(preset, presetCfg, lectureSeconds));

  // Trimmed from the *end*, so a very long recording loses its last stretch
  // rather than its first. Losing the front would be worse: the opening of a
  // lecture is where the framing is, and a reel that skips it is wrong in a way
  // a reel that stops early is not.
  if (body.length > cfg.maxContextChars) {
    body = `${body.slice(0, cfg.maxContextChars)}\n\n[the rest of this lecture was too long to send]`;
  }

  log.info(`highlights: ${entry.title} — ${body.length} chars, ${cues.length} cues`);

  const instruction = `${settings.prompts.highlights.trim()}\n\n# The lecture\n\n${body}`;
  const limits = {
    leadInSeconds: cfg.leadInSeconds,
    minSegmentSeconds: Math.max(cfg.minSegmentSeconds, presetCfg.minSeconds),
    maxSeconds: presetCfg.maxSeconds,
  };
  const ask = (turns: Turn[]) =>
    vertexLimit(() =>
      generateChat({
        model: cfg.model,
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        systemInstruction: instruction,
        maxOutputTokens: cfg.maxOutputTokens,
        thinkingLevel: cfg.thinkingLevel,
        timeoutMs: cfg.timeoutSeconds * 1000,
      }),
    );

  const opening = `Cut the ${preset} reel for this lecture.`;
  let reply = await ask([{ role: "user", text: opening }]);
  if (!reply) throw new Error("The model returned nothing.");
  let cleaned = clean(readJsonArray(reply), cues, lectureSeconds, limits);

  /**
   * One editor's note, when the first cut came back too coarse.
   *
   * Every measurement so far says the same thing: asked for spans averaging
   * fifteen seconds it returns twenty-nine, and asked for forty spans it returns
   * twenty-two. Telling it so, with its own numbers, and letting it revise is
   * both cheaper and more reliable than asking louder in the opening prompt —
   * the second turn reuses the whole cached context and it can see what it
   * actually did rather than what it intended.
   *
   * Once, not until satisfied. Each pass costs a call, and a model that ignores
   * the note twice is not going to yield on the third.
   */
  // The same arithmetic the brief was written from, so the note can't complain
  // about a number the model was never given.
  const { spans: wanted, aimSeconds } = plan(presetCfg, lectureSeconds);
  const average = cleaned.length > 0
    ? cleaned.reduce((sum, s) => sum + (s.end - s.start), 0) / cleaned.length
    : 0;
  const holes = gaps(cleaned, lectureSeconds, cfg.maxGapSeconds);
  // The count is a recommendation, so this has real slack in it: a reel that
  // came back at 49 against 50, or 44, is the right sort of number and paying
  // for a second pass over it would be a call for nothing. Twenty short of
  // fifty is a different thing — that is a summary wearing a reel's name.
  const tooFew = cleaned.length < wanted * 0.75;
  const tooLong = average > aimSeconds * 1.35;

  if (cleaned.length > 0 && (tooFew || tooLong || holes.length > 0)) {
    log.info(
      `highlights: ${preset} came back ${cleaned.length} spans averaging ${Math.round(average)}s `
      + `(wanted ${wanted}+ at ~${aimSeconds}s), ${holes.length} uncovered stretch(es) `
      + "— asking for a second pass",
    );
    const note = [
      `That pass gave ${cleaned.length} spans averaging ${Math.round(average)} seconds.`,
      `The brief asked for around ${wanted} spans averaging ${aimSeconds} seconds.`,
      "",
      // The specific holes, by timestamp. Far more use than "cover the lecture":
      // it can go and read those minutes again rather than guess at where it was
      // thin, and the transcript it needs is already in the context above.
      holes.length > 0
        ? "These stretches have nothing in them at all:\n"
          + holes.map(([from, to]) =>
            `  - ${clockText(from)} to ${clockText(to)} (${Math.round((to - from) / 60)} minutes)`).join("\n")
          + "\n\nGo back to the transcript for each one and read what is actually said there. If it is "
          + "admin, a break or a tangent, leave it out and say nothing. If there is a definition, a "
          + "figure, an example or an argument in it — and in a lecture there usually is — cut it."
        : "",
      tooLong
        ? "Your spans are also too long. Cut the run-up and the trailing-off from each one — start on "
          + "the words that carry the point, end when it is made. Where a span covers two separate "
          + "claims, split it into two and drop whatever sits between them."
        : "",
      tooFew && holes.length === 0
        ? "You have too few. Work through the transcript again from the start, in order, and find the "
          + "moments you passed over — a lecture this long has more in it than you took."
        : "",
      "",
      "Keep everything you already had that was good. Return the whole revised reel as JSON, in the "
      + "same format. Not a diff, not a note — the full list.",
    ].filter(Boolean).join("\n");

    const second = await ask([
      { role: "user", text: opening },
      { role: "model", text: reply },
      { role: "user", text: note },
    ]);
    if (second) {
      const revised = clean(readJsonArray(second), cues, lectureSeconds, limits);
      // Kept only if it actually improved on what was complained about: more
      // cuts, or the same cuts covering more of the lecture. A revision that came
      // back thinner is a worse reel, and having paid for it is no reason to use
      // it.
      const better = revised.length > cleaned.length
        || gaps(revised, lectureSeconds, cfg.maxGapSeconds).length < holes.length;
      if (better) {
        cleaned = revised;
        reply = second;
      }
    }
  }

  // A ceiling with room in it, not the target.
  //
  // The share says what a reel of this kind should be about; it is not a budget
  // to be spent to the last second, and a lecture with more in it than usual
  // should give a longer reel rather than a thinner one. This only bites when
  // something has gone properly wrong — a "skim" running to half the lecture —
  // and coverage outranks it either way.
  const segments = trim(
    cleaned,
    lectureSeconds * (presetCfg.share / 100) * 1.5,
    cfg.maxGapSeconds,
    lectureSeconds,
    wanted,
  );
  if (segments.length === 0) {
    throw new HighlightsUnavailableError(
      "Nothing came back that could be played — no usable spans in the reply. Worth trying again.",
    );
  }

  const reel: Reel = {
    preset,
    madeAt: new Date().toISOString(),
    model: cfg.model,
    steer,
    lectureSeconds,
    segments,
    seconds: Math.round(segments.reduce((sum, s) => sum + (s.end - s.start), 0)),
  };
  writeReel(key, reel);
  log.info(
    `highlights: ${preset} — ${segments.length} spans, ${clockText(reel.seconds)}`
    + `${cleaned.length > segments.length ? ` (${cleaned.length - segments.length} trimmed to fit)` : ""}`,
  );

  return payload(readReels(key));
}

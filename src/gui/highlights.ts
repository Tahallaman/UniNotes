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
 * The scores did not survive that change, though they outlived it by a while. A
 * 1–5 rating on every span was load-bearing when one pass was cut three ways;
 * afterwards its only job was ordering an over-length reel's spans for deletion,
 * and that deletion never ran. What it did do was offer the model a way to
 * include something without committing to it — marginal spans came back scored
 * 2 rather than left out. A span is now in or out, and the prompt says so.
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
import { captionsPath, parseVtt, type Cue } from "../panopto/captions.js";
import { listLectures, readNotes } from "./library.js";
import { readOverview } from "./explain.js";
import { effectiveConfig } from "./effective.js";
import { log } from "../utils/logger.js";

/** One span of lecture worth watching. */
export interface Segment {
  /** Seconds, snapped to a cue boundary. */
  start: number;
  end: number;
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
/**
 * A closing full stop, question or exclamation, allowing for a quote or bracket
 * after it. Auto-transcripts punctuate, which is what makes finishing a sentence
 * something the code can do rather than something the model has to be asked for.
 */
const ENDS_SENTENCE = /[.!?]["')\]]*\s*$/;
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
function readTime(value: unknown, side: "first" | "last" = "first"): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  let text = value.trim();
  // The transcript is labelled with ranges now, so a model will occasionally
  // hand a whole one back in a single field. Which half is wanted depends on
  // which field it is: "07:01–07:06" as a start means 07:01 and as an end means
  // 07:06. Reading it as the wrong half is the mistake this whole change is
  // about, so it is worth the two lines rather than the dropped span.
  const range = text.split(/\s*[–—-]\s*|\s+to\s+/i).filter((part) => part.trim().length > 0);
  if (range.length > 1) text = (side === "last" ? range[range.length - 1] : range[0]).trim();
  const clock = /^(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/.exec(text);
  if (clock) {
    const [, h, m, s] = clock;
    return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
  }
  const plain = Number(text);
  return Number.isFinite(plain) && plain >= 0 ? plain : null;
}

/**
 * The two clocks, named — because the direction is the thing that goes wrong.
 *
 * A lecture Panopto trimmed at the front has a transcript whose clock runs
 * `offsetSeconds` behind the recording you can download. Which of the two any
 * given number is in is decided by where it came from, and buildHighlights says
 * which side each one sits on; these only carry it across.
 *
 * Named rather than written out as `+ offset` at each site for the reason the
 * player names the same pair: the bug this feature was built around was a
 * conversion applied in the wrong direction, and a sign is far easier to get
 * wrong six times than once. The client's equivalents are toVideo/toTranscript
 * in web/app.js.
 */
function toRecording(transcriptSeconds: number, offsetSeconds: number): number {
  return transcriptSeconds + offsetSeconds;
}

/** Clamped at zero: a recording time before the transcript starts isn't in it. */
function toTranscript(recordingSeconds: number, offsetSeconds: number): number {
  return Math.max(0, recordingSeconds - offsetSeconds);
}

// ── What gets sent ───────────────────────────────────────────────────────────

/**
 * One subtitle cue — the same type `parseVtt` returns, not a copy of it.
 *
 * Re-exported rather than restated so a caller building cues for this module
 * needn't reach past it, and so the two can't drift: a second hand-written copy
 * of a three-field interface is structurally identical right up until one of
 * them grows a field, at which point nothing complains.
 */
export type { Cue };

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
export function blocks(cues: Cue[], seconds: number, offsetSeconds = 0): string {
  const out: string[] = [];
  let start = -1;
  let end = -1;
  let text: string[] = [];

  // Both ends of the block, not just its start.
  //
  // Start-only was a quiet, systematic bias towards cutting people off. The
  // model is told every time it gives must be one that appears here, so with
  // only starts printed, every *end* it could name was some later block's start
  // — which is a few seconds past the words it meant to keep, or, if it named
  // the block it wanted, a few seconds short of them. There was no way to say
  // "up to the end of this" at all. Printing the end makes that sayable, and
  // makes the silence between one block's end and the next one's start visible,
  // which is where a cut belongs.
  //
  // Printed in the recording's clock, which for a lecture Panopto trimmed at the
  // front is not the one these cues are written in. The notes in the same prompt
  // are in the recording's, so this is the side that moves — see buildHighlights.
  const flush = () => {
    if (start >= 0 && text.length > 0) {
      const from = clockText(toRecording(start, offsetSeconds));
      const to = clockText(toRecording(end, offsetSeconds));
      out.push(`[${from}–${to}] ${text.join(" ")}`);
    }
    start = -1;
    end = -1;
    text = [];
  };

  for (const cue of cues) {
    if (start < 0) start = cue.start;
    end = cue.end;
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
  cfg: {
    leadInSeconds: number;
    minSegmentSeconds: number;
    /** The backstop against a runaway span. Not the preset's own ceiling. */
    maxSegmentSeconds?: number;
    /** Optional so a test can hand this three numbers and mean none of them. */
    tailSeconds?: number;
    finishSentenceSeconds?: number;
    joinGapSeconds?: number;
  } = effectiveConfig().highlights,
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

  /** The end of the cue covering `t`, so a span closes on a whole cue. */
  const snapEnd = (t: number): number => {
    let best = t;
    for (const cue of cues) {
      if (cue.end >= t) { best = Math.max(t, cue.end); break; }
    }
    return best;
  };

  /**
   * Carry an end forward to the end of the sentence it lands in.
   *
   * A cue boundary is a breath, not a full stop — "so what we do here is" is a
   * complete cue and half a thought, and ending on it is the cut that reads as
   * broken however well-chosen the span was. The transcript is punctuated, so
   * the real boundary is available; take it, as long as it is close.
   *
   * If no sentence closes within the allowance, the end stays where it was: a
   * hard cut is better than a span that ran on into the next point looking for
   * a full stop that never came.
   */
  const finishSentence = (t: number, allowance: number): number => {
    if (allowance <= 0) return t;
    for (const cue of cues) {
      if (cue.end < t) continue;
      if (cue.end > t + allowance) break;
      if (ENDS_SENTENCE.test(cue.text)) return cue.end;
    }
    return t;
  };

  const segments: Segment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;

    const from = readTime(row.start);
    const to = readTime(row.end, "last");
    if (from === null || to === null || to <= from) continue;

    const why = String(row.why ?? "").trim().slice(0, 300);
    if (!why) continue;

    let start = snapStart(Math.max(0, from - cfg.leadInSeconds));
    let end = finishSentence(snapEnd(to), cfg.finishSentenceSeconds ?? 0);
    if (lectureSeconds > 0) {
      start = Math.min(start, lectureSeconds);
      end = Math.min(end, lectureSeconds);
    }
    // The only ceiling left, and it is a backstop rather than a shape: the
    // preset's own maxSeconds is asked for in the brief and no longer enforced
    // here. Cutting a span back to a number overruled the model on exactly the
    // spans where it mattered — the long ones are long because something was
    // still being explained, and the cap landed mid-explanation.
    const ceiling = cfg.maxSegmentSeconds ?? 0;
    if (ceiling > 0 && end - start > ceiling) {
      const cue = cues.find((c) => c.end >= start + ceiling);
      end = Math.max(cue?.end ?? start + ceiling, start + cfg.minSegmentSeconds);
    }
    if (end - start < cfg.minSegmentSeconds) continue;

    segments.push({ start, end, why });
  }

  segments.sort((a, b) => a.start - b.start);

  // Overlaps are handled by the same pass that joins touching spans: an overlap
  // is a negative gap, and two spans covering the same seconds are describing
  // one stretch of lecture. There used to be a separate rule here that resolved
  // an overlap by deleting the lower-scored span, which is the only thing the
  // scores were still doing and a poor use of them — it threw away material the
  // model had chosen in order to break a tie.
  const joined = join(segments, cfg.joinGapSeconds ?? 0);
  return runOut(joined.slice(0, MAX_SEGMENTS), lectureSeconds, cfg.tailSeconds ?? 0);
}

/**
 * Spans with nothing between them are one span.
 *
 * Three entries in a row separated by a second of silence are not three cuts —
 * nothing is being cut. They play as one continuous stretch, so presenting them
 * as three rows with three reasons describes a distinction nobody watching can
 * hear, and it is the model thinking in claims rather than in cuts.
 *
 * Both reasons are kept, in order. The older rule here refused to merge on the
 * grounds that a merged span inherits a reason describing half of itself — true,
 * and the answer is to carry both halves rather than to leave the cut broken in
 * two.
 */
function join(segments: Segment[], gapSeconds: number): Segment[] {
  if (segments.length === 0) return segments;
  const out: Segment[] = [segments[0]];
  for (const segment of segments.slice(1)) {
    const last = out[out.length - 1];
    if (segment.start - last.end > gapSeconds) { out.push(segment); continue; }
    out[out.length - 1] = {
      start: last.start,
      end: Math.max(last.end, segment.end),
      // Trimmed at the same 300 the model's own reasons are held to, so a run of
      // joins can't grow one unbounded.
      why: `${last.why}; ${segment.why}`.slice(0, 300),
    };
  }
  return out;
}

/**
 * Give every span a beat to finish on.
 *
 * A cue's end is where the transcriber stopped writing, which is a word or two
 * before the speaker stopped talking — so a cut on that boundary takes the end
 * of the sentence with it. See highlights.tailSeconds for the measurement.
 *
 * Last of all, deliberately. Ahead of the cap it would be capped away on exactly
 * the spans already at their ceiling; ahead of the overlap pass a span reaching a
 * second into its neighbour would be deleted outright rather than shortened,
 * because that pass resolves an overlap by dropping the lighter span. Here the
 * only thing it can do is extend a span into silence it already owns.
 */
function runOut(segments: Segment[], lectureSeconds: number, tailSeconds: number): Segment[] {
  if (tailSeconds <= 0) return segments;
  return segments.map((segment, index) => {
    // Whatever comes next owns the time after it: the following span, or the end
    // of the lecture. Where a span already runs up to the next one, playback is
    // continuous and nothing was being clipped, so this comes to nothing.
    const next = segments[index + 1]?.start ?? (lectureSeconds > 0 ? lectureSeconds : Infinity);
    return { ...segment, end: Math.min(segment.end + tailSeconds, Math.max(segment.end, next)) };
  });
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
    skim: "The sharpest of the three, and the one where restraint matters most. "
      + "Very short cuts — often a single sentence, ten or fifteen seconds — with "
      + "a great deal of lecture dropped between them, so that watching it start "
      + "to finish tells the whole story in a small fraction of the time. Favour "
      + "the sentence that states a thing over the sentence that explains it, and "
      + "when a point takes a minute to make, take the ten seconds where it "
      + "lands rather than the minute. Keep the few short connectives that hold "
      + "the argument together, or it plays as a list of facts. If a moment is "
      + "merely useful rather than necessary, it belongs in one of the longer "
      + "reels and not in this one.",
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
    `- Around ${spans} spans, give or take. That sort of number rather than a dozen, because how`,
    `  often a reel cuts is what makes it a reel rather than a summary. It is a sense of scale, not`,
    `  a quota — if this lecture genuinely wants fewer longer stretches, or more shorter ones, do`,
    `  that instead and let the number land where it lands.`,
    `- Cuts of around ${aimSeconds} seconds, most of them somewhere near ${cfg.minSeconds}–${cfg.maxSeconds}.`,
    `  Go longer whenever the material needs it: a worked example that takes a minute to land is one`,
    `  span of a minute, not three of twenty seconds.`,
    `- Which should come to something like ${clockText(target)}, or ${cfg.share}% of this ${minutes}-minute`,
    `  lecture. That figure is a recommendation and you may go past it where the material genuinely`,
    `  earns it — but treat going a long way past it as a sign you have kept things you should have`,
    `  cut, not as a lecture that happened to be dense. At double it, the reel has stopped being one.`,
    "",
    "Before you answer, read your list back as a reel — in order, with the gaps closed — and ask",
    "whether it tells the story of this lecture to someone who did not attend. Fix what it needs:",
    `a stretch you skipped, a span that ends mid-sentence, a join that lands mid-thought, or a run`,
    "of spans sitting end to end that should have been one.",
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
  // A length, so it belongs to neither clock and the offset does not touch it.
  const lectureSeconds = cues[cues.length - 1].end;

  /**
   * How far this recording runs ahead of its own transcript.
   *
   * The prompt is written entirely in the recording's clock — the notes' clock,
   * the player's clock, the one the student sees — because that is the clock
   * everything else in UniNotes speaks, and because a time the model mentions in
   * prose should be a time you can go and find. So the transcript is what moves,
   * and the notes go in untouched.
   *
   * What comes *back* is converted the other way before it is saved. A reel is
   * stored in the transcript's clock so that it survives this number changing:
   * correct a 230 to a 237 next week and a stored transcript time still plays in
   * the right place, where a stored file time would be seven seconds wrong for
   * good, with nothing on screen to say so.
   */
  const offset = entry.captionOffset;

  const notes = readNotes(key, "raw") ?? readNotes(key, "pretty");
  const overview = readOverview(notes?.content ?? "");

  let body =
    `Lecture: "${entry.title}" (${entry.courseCode}). ` +
    (offset
      ? `The speech runs from ${clockText(toRecording(0, offset))} `
        + `to ${clockText(toRecording(lectureSeconds, offset))}, `
        + `${clockText(lectureSeconds)} of lecture.`
      : `The recording runs ${clockText(lectureSeconds)}.`) +
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
  //
  // Untouched, and this is the half of the alignment that matters: the whole
  // instruction is "find, in the transcript, when the notes say this happened",
  // and on a trimmed recording the two disagree by minutes. Measured on the
  // lecture this was built against: the notes put a quotation at 10:59 that the
  // transcript has at 07:01. Sent unaligned, that instruction points four
  // minutes from where it points, and a time taken from the notes still snaps to
  // a real cue — so the mistake would come back looking perfectly valid.
  if (notes) body += section("The notes for this lecture", stripFrontmatter(notes.content));
  body += section(
    "The transcript. Every start and end you give must be a time that appears here",
    blocks(cues, cfg.blockSeconds, offset),
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
    // The preset's own minSeconds no longer joins this. It was a floor on what
    // the model was allowed to choose, and a short span it chose deliberately —
    // the ten seconds where the number is said — is the point of the reel, not a
    // mistake to round away. What is left is the snapping-artefact backstop.
    leadInSeconds: cfg.leadInSeconds,
    minSegmentSeconds: cfg.minSegmentSeconds,
    maxSegmentSeconds: cfg.maxSegmentSeconds,
    tailSeconds: cfg.tailSeconds,
    finishSentenceSeconds: cfg.finishSentenceSeconds,
    joinGapSeconds: cfg.joinGapSeconds,
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

  /**
   * The answer, brought back into the transcript's clock.
   *
   * The model was given the recording's, so this is where a reel returns to the
   * one it is stored and validated in — cue snapping happens against the cues as
   * Panopto wrote them, and a saved reel has to outlive a correction to the
   * offset it was cut under.
   */
  const read = (text: string): unknown[] => {
    const rows = readJsonArray(text);
    if (!offset) return rows;
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      const back = (v: unknown, side: "first" | "last"): unknown => {
        const at = readTime(v, side);
        return at === null ? v : clockText(toTranscript(at, offset));
      };
      return { ...r, start: back(r.start, "first"), end: back(r.end, "last") };
    });
  };

  const opening = `Cut the ${preset} reel for this lecture.`;
  let reply = await ask([{ role: "user", text: opening }]);
  if (!reply) throw new Error("The model returned nothing.");
  let cleaned = clean(read(reply), cues, lectureSeconds, limits);

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
      // thin, and the transcript it needs is already in the context above. Named
      // in the recording's clock, like everything else it has been shown — these
      // are measured against spans that have already been converted back.
      holes.length > 0
        ? "These stretches have nothing in them at all:\n"
          + holes.map(([from, to]) =>
            `  - ${clockText(toRecording(from, offset))} to ${clockText(toRecording(to, offset))} `
            + `(${Math.round((to - from) / 60)} minutes)`).join("\n")
          + "\n\nGo back to the transcript for each one and read what is actually said there. If it is "
          + "admin, a break or a tangent, leave it out and say nothing. If there is a definition, a "
          + "figure, an example or an argument in it — and in a lecture there usually is — cut it."
        : "",
      tooLong
        ? `Your spans are too long — averaging ${Math.round(average)} seconds against the ${aimSeconds} `
          + "this reel is cut at. Tighten them, one at a time, and prefer that to dropping any:\n"
          + "  - Start later. Almost every span opens on the run-up rather than on the point.\n"
          + "  - End earlier. Stop on the words that land it, not on the sentence after that "
          + "restates it or the aside that follows it.\n"
          + "  - Where a span carries a good half and a dull half, keep the good half.\n"
          + "Then, once each one is as tight as it can be and still make sense, look at the reel as a "
          + "whole. If it is still far longer than the brief, drop the spans that add least to the "
          + "story — the ones a listener would not miss — rather than shaving the good ones further. "
          + "What has to come out of this is a cohesive cut that plays as one story, not a long one "
          + "with every moment in it."
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
      const revised = clean(read(second), cues, lectureSeconds, limits);
      const revisedAverage = revised.length > 0
        ? revised.reduce((sum, s) => sum + (s.end - s.start), 0) / revised.length
        : 0;
      const revisedHoles = gaps(revised, lectureSeconds, cfg.maxGapSeconds).length;
      // Kept only if it improved on what was complained about — and "what was
      // complained about" has to include length, which it did not.
      //
      // The note asks a reel with over-long spans to tighten them. The model
      // does exactly that and hands back the same number of shorter spans, and
      // the old test — more spans, or fewer holes — is false for both, so the
      // revision was discarded every time. A second call was being paid for, the
      // right revision was coming back, and it was thrown away unread. It is why
      // reel length never moved however the brief was worded.
      //
      // Tightening counts only while coverage holds: spans that got shorter by
      // dropping half the lecture is not the trade being asked for.
      const tighter = tooLong
        && revisedAverage < average * 0.9
        && revised.length >= cleaned.length * 0.8
        && revisedHoles <= holes.length;
      const better = revised.length > cleaned.length
        || revisedHoles < holes.length
        || tighter;
      // Logged either way. A second pass is a call that has been paid for, and
      // whether its answer was used is not something to have to infer from the
      // reel afterwards — the last time this went wrong, the revision was being
      // discarded silently and the symptom looked like a prompt that would not
      // take effect.
      log.info(
        `highlights: revision came back ${revised.length} spans averaging ${Math.round(revisedAverage)}s, `
        + `${revisedHoles} uncovered — ${better ? "kept" : "discarded"}`
        + `${better ? "" : ` (was ${cleaned.length} at ${Math.round(average)}s, ${holes.length} uncovered)`}`,
      );
      if (better) {
        cleaned = revised;
        reply = second;
      }
    }
  }

  // What the model returned is the reel.
  //
  // There used to be a pass here that dropped the lowest-scored spans until the
  // reel fitted its share. It never once ran — it refused to drop anything while
  // the reel had fewer spans than the brief asked for, which is nearly always —
  // so the length it was supposed to guarantee was never guaranteed, and the
  // scores it ordered by were being asked for and thrown away. The share is a
  // recommendation, made in the brief, where a recommendation belongs.
  const segments = cleaned;
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
    `highlights: ${preset} — ${segments.length} spans, ${clockText(reel.seconds)}, `
    + `${Math.round((100 * reel.seconds) / lectureSeconds)}% of the lecture `
    + `(brief asked ${presetCfg.share}%)`,
  );

  return payload(readReels(key));
}

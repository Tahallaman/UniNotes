/**
 * Detect recordings with nothing in them, before spending a pipeline run on one.
 *
 * A Panopto recording that was started and never used costs a download, a split
 * into eight parts, eight Gemini calls and a prettify — and returns notes worth
 * nothing. Worse, an empty video is exactly when the model invents: asked for
 * notes on "part 3 of 8" of a named course with no content to describe, it fills
 * the silence with a plausible syllabus. Observed on 2026-07-25, on a two-hour
 * recording that was a desktop for two minutes and black for the rest.
 *
 * ── What counts as blank
 *
 * Two visual shapes, because "blank" isn't only black:
 *   - black    — no signal at all
 *   - frozen   — a static screen (an idle desktop, a title slide left up)
 *
 * And audio, which is the safety catch. A lecturer talking over one unchanging
 * slide is a perfectly good lecture and a frozen picture; an audio-only
 * recording is worth every bit as much as a visual one. So sound alone is enough
 * to make a recording worth processing, and a video is only blank when it is
 * BOTH visually dead AND silent.
 *
 * ── Why sampling
 *
 * Running blackdetect/freezedetect over two hours means decoding two hours.
 * Instead this takes a handful of short probes spread across the file. The
 * failure mode is deliberately one-sided: any probe showing motion or sound
 * marks the recording as worth processing, so the cost of sampling is the
 * occasional blank video that gets processed anyway — never a real lecture that
 * gets skipped.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../../config.js";
import { log, type LogContext } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  /** Offset into the source video, in seconds. */
  at: number;
  /** Seconds of this probe covered by a black run. */
  black: number;
  /** Seconds covered by a freeze run. */
  frozen: number;
  /** Seconds covered by silence. */
  silent: number;
  /** Probe length in seconds. */
  length: number;
}

export interface BlankAnalysis {
  blank: boolean;
  /** Fraction of probes that were visually dead (black or frozen). */
  deadFraction: number;
  /** Fraction of probes that were silent. */
  silentFraction: number;
  probes: ProbeResult[];
  /** One line fit for a log or a status message. */
  summary: string;
}

/**
 * Marks a segment whose notes were generated locally rather than by a model.
 *
 * An HTML comment, so it is invisible in every markdown renderer, and stable, so
 * a resumed run can still tell which checkpointed parts were blank without
 * re-probing the video or widening the checkpoint format.
 */
export const BLANK_SEGMENT_MARKER = "<!-- uninotes:blank-segment -->";

/**
 * The note written in place of a blank segment.
 *
 * Written here rather than asked for, because asking a model to describe an
 * empty video is the one prompt reliably observed to produce fiction. Carries
 * real timestamps so the segment still lines up with the rest of the lecture.
 */
export function blankSegmentNote(offsetSeconds: number, lengthSeconds: number): string {
  const from = formatClock(offsetSeconds);
  const to = formatClock(offsetSeconds + lengthSeconds);
  return [
    `### [${from}] No content in this segment`,
    BLANK_SEGMENT_MARKER,
    `- [${from} - ${to}] The recording shows no picture change and no sound. Not sent for notes.`,
  ].join("\n");
}

/**
 * Seconds of this probe covered by one of ffmpeg's *detect filters.
 *
 * Pairs `<key>_start` with `<key>_end` rather than summing the `<key>_duration`
 * lines, because a run still in progress when the probe ends never gets a
 * duration. freezedetect in particular only emits freeze_duration at
 * freeze_end — so a segment that is frozen from start to finish, the exact case
 * this exists to catch, reported zero. A dangling start therefore runs to the
 * end of the probe.
 */
function coveredSeconds(stderr: string, key: string, length: number): number {
  const events = [...stderr.matchAll(new RegExp(`${key}_(start|end)\\s*[:=]\\s*(-?[0-9.]+)`, "g"))];

  let total = 0;
  let openedAt: number | null = null;
  for (const [, kind, rawValue] of events) {
    const at = parseFloat(rawValue);
    if (!Number.isFinite(at)) continue;
    if (kind === "start") {
      if (openedAt === null) openedAt = Math.max(0, at);
    } else if (openedAt !== null) {
      total += Math.max(0, Math.min(length, at) - openedAt);
      openedAt = null;
    }
  }
  // Still open at EOF — it covered the rest of the probe.
  if (openedAt !== null) total += Math.max(0, length - openedAt);

  return Math.min(length, total);
}

/**
 * Measure one short window of the video.
 *
 * `-ss` before `-i` so ffmpeg seeks rather than decoding from the start — the
 * difference between a probe at 1:45:00 costing a moment and costing minutes.
 * The video is scaled down first because these filters only need to know whether
 * pixels changed, not what they were.
 */
async function probeAt(videoPath: string, at: number, length: number): Promise<ProbeResult> {
  const { blackPixelThreshold, freezeNoiseDb, silenceNoiseDb } = CONFIG.blankDetection;

  const args = [
    "-hide_banner", "-nostats",
    "-ss", String(at),
    "-t", String(length),
    "-i", videoPath,
    "-vf", `scale=160:-2,blackdetect=d=0.5:pix_th=${blackPixelThreshold},freezedetect=n=${freezeNoiseDb}dB:d=0.5`,
    "-af", `silencedetect=n=${silenceNoiseDb}dB:d=0.5`,
    "-f", "null", "-",
  ];

  let stderr = "";
  try {
    const result = await execFileAsync("ffmpeg", args, { maxBuffer: 20 * 1024 * 1024 });
    stderr = result.stderr;
  } catch (err) {
    // ffmpeg exits non-zero on a probe past the end of the file, and on files
    // with no audio stream. Its stderr still carries whatever it did measure.
    stderr = (err as { stderr?: string })?.stderr ?? "";
  }

  const black = coveredSeconds(stderr, "black", length);
  const frozen = coveredSeconds(stderr, "freeze", length);

  // No audio stream at all is silence, not "unknown" — a recording with no audio
  // track and no picture is the clearest possible blank.
  const hasAudioStream = /Stream #\d+:\d+.*: Audio:/.test(stderr);
  const silent = hasAudioStream ? coveredSeconds(stderr, "silence", length) : length;

  return { at, black, frozen, silent, length };
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * Is this recording empty?
 *
 * Never throws: a detector that can break the pipeline is worse than one that
 * occasionally lets a blank video through, so any failure reports "not blank"
 * and the lecture processes as it would have before.
 */
export async function analyseBlankness(
  videoPath: string,
  durationSeconds: number,
  ctx?: LogContext,
): Promise<BlankAnalysis> {
  const { probeCount, probeSeconds, coverage } = CONFIG.blankDetection;

  const notBlank = (summary: string): BlankAnalysis => ({
    blank: false, deadFraction: 0, silentFraction: 0, probes: [], summary,
  });

  // Too short to sample meaningfully, and too cheap to be worth skipping anyway.
  if (durationSeconds < probeSeconds * 2) {
    return notBlank("too short to analyse");
  }

  // The whole segment is sampled — no lead-in skipped. This runs per part, and
  // "the first two minutes are a desktop" is precisely what we want to catch in
  // the part that contains it.
  const start = 0;
  const usable = durationSeconds - probeSeconds;
  if (usable <= 0) return notBlank("too short to analyse");

  const probes: ProbeResult[] = [];
  try {
    for (let i = 0; i < probeCount; i++) {
      const at = start + (usable * i) / Math.max(1, probeCount - 1);
      const probe = await probeAt(videoPath, at, probeSeconds);
      probes.push(probe);

      // Early exit: one probe with motion AND sound settles it. On a real
      // lecture this stops after the first probe, so the check costs ~a second.
      const dead = probe.black >= probe.length * coverage || probe.frozen >= probe.length * coverage;
      const silent = probe.silent >= probe.length * coverage;
      if (!dead && !silent) {
        return notBlank(`content found at ${formatClock(at)}`);
      }
    }
  } catch (err) {
    log.warn(
      `Blank-video check failed (${err instanceof Error ? err.message : String(err)}) — processing the lecture normally.`,
      ctx,
    );
    return notBlank("check failed");
  }

  const deadCount = probes.filter(
    (p) => p.black >= p.length * coverage || p.frozen >= p.length * coverage,
  ).length;
  const silentCount = probes.filter((p) => p.silent >= p.length * coverage).length;

  const deadFraction = deadCount / probes.length;
  const silentFraction = silentCount / probes.length;

  // Both, never either. A silent recording of changing slides still carries the
  // lecture; a talked-over static slide certainly does.
  const blank = deadFraction === 1 && silentFraction === 1;

  const summary = blank
    ? `${probes.length} probes across ${formatClock(durationSeconds)} found no picture change and no sound`
    : `${deadCount}/${probes.length} probes visually dead, ${silentCount}/${probes.length} silent`;

  return { blank, deadFraction, silentFraction, probes, summary };
}

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
 * BOTH visually dead AND carries no speech.
 *
 * ── Why "no speech" is not the same as "silent"
 *
 * silencedetect answers "did the signal drop below a threshold", which is the
 * wrong question for a recording whose mic was never live. Observed on
 * 2026-07-25: COMPSYS 730's 21 Jul recording held one unchanging slide for the
 * whole of its first segment with nobody miked, and its room tone measured
 * -47dB — above the -50dB silence floor, so silencedetect reported nothing and
 * the audio veto blocked the skip. All eight parts were uploaded and written up.
 *
 * So the audio test measures the level as well. Room tone and speech separate
 * cleanly in a way a threshold crossing does not capture: that dead recording
 * sat at a -47dB median across its probes, while a recording with real audio
 * measured -28dB. speechFloorDb goes between them, nearer the dead end.
 *
 * ── The audio pass reads every second; the visual pass samples
 *
 * The two signals want different treatment, so they get it.
 *
 * Audio is scanned CONTIGUOUSLY, in chunks covering the whole segment, and the
 * verdict is the LOUDEST chunk — "was anyone ever speaking here". Sampling would
 * be wrong for audio: a lecture that starts thirteen minutes into a segment
 * leaves most of it dead, and any statistic over spread-out probes (a mean, a
 * median, a count) is dominated by the dead majority and throws the lecture
 * away. The loudest chunk cannot miss it. Measured cost on a 15-minute segment:
 * 3.4 seconds, because -vn skips video decoding entirely.
 *
 * Chunks are long (tens of seconds) so the statistic is robust. A door closing
 * inside a 30s window barely moves that window's mean, while someone talking
 * moves it a long way — on the two recordings this was calibrated against, the
 * dead one's loudest chunk was -40dB and the live one's was -24dB.
 *
 * Video is SAMPLED, because deciding whether the picture moves does not need
 * every frame, and decoding two hours of video to find out would cost minutes.
 *
 * Both passes exit the moment they find a reason to process the segment, and
 * both fail one-sidedly: the cost of getting it wrong is an empty video that
 * gets processed anyway, never a real lecture that gets skipped.
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
  /** Probe length in seconds. */
  length: number;
}

export interface BlankAnalysis {
  blank: boolean;
  /** Fraction of visual probes that were dead (black or frozen). */
  deadFraction: number;
  /**
   * Level of the loudest audio chunk, in dBFS — the whole audio verdict in one
   * number. null when the segment has no audio stream, or no chunk could be read.
   */
  loudestDb: number | null;
  /** Where that loudest chunk started, in seconds. */
  loudestAt: number | null;
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
  const { blackPixelThreshold, freezeNoiseDb } = CONFIG.blankDetection;

  const args = [
    "-hide_banner", "-nostats",
    "-ss", String(at),
    "-t", String(length),
    "-i", videoPath,
    "-vf", `scale=160:-2,blackdetect=d=0.5:pix_th=${blackPixelThreshold},freezedetect=n=${freezeNoiseDb}dB:d=0.5`,
    // The audio pass owns audio entirely, so drop it here — decoding it twice
    // would buy nothing.
    "-an",
    "-f", "null", "-",
  ];

  let stderr = "";
  try {
    const result = await execFileAsync("ffmpeg", args, { maxBuffer: 20 * 1024 * 1024 });
    stderr = result.stderr;
  } catch (err) {
    // ffmpeg exits non-zero on a probe past the end of the file. Its stderr
    // still carries whatever it did measure.
    stderr = (err as { stderr?: string })?.stderr ?? "";
  }

  return {
    at,
    black: coveredSeconds(stderr, "black", length),
    frozen: coveredSeconds(stderr, "freeze", length),
    length,
  };
}

/**
 * Mean level of one stretch of audio, in dBFS.
 *
 * Returns null when the level could not be read at all — no audio stream, or a
 * chunk ffmpeg refused. Null is deliberately not folded into "quiet": an
 * unmeasured chunk is not evidence of silence, and treating it as such would
 * skip lectures on a decode hiccup.
 */
async function chunkLevel(
  videoPath: string,
  at: number,
  length: number,
): Promise<{ level: number | null; hasAudioStream: boolean }> {
  const args = [
    "-hide_banner", "-nostats",
    "-ss", String(at),
    "-t", String(length),
    "-i", videoPath,
    // -vn is what makes scanning the whole segment affordable: no video decode.
    "-vn",
    "-af", "volumedetect",
    "-f", "null", "-",
  ];

  let stderr = "";
  try {
    stderr = (await execFileAsync("ffmpeg", args, { maxBuffer: 20 * 1024 * 1024 })).stderr;
  } catch (err) {
    // A file with no audio track makes -vn produce no output stream at all, so
    // ffmpeg exits non-zero. That is a real answer, not a failure.
    stderr = (err as { stderr?: string })?.stderr ?? "";
  }

  const raw = stderr.match(/mean_volume:\s*(-?[0-9.]+) dB/)?.[1];
  const value = raw === undefined ? NaN : parseFloat(raw);
  return {
    level: Number.isFinite(value) ? value : null,
    hasAudioStream: /Stream #\d+:\d+.*: Audio:/.test(stderr),
  };
}

interface AudioScan {
  /** Loudest chunk level in dBFS, or null when nothing was measurable. */
  loudestDb: number | null;
  loudestAt: number | null;
  /** True as soon as any chunk clears the speech floor. */
  speechFound: boolean;
  /**
   * The file carries no audio track. Definitive silence rather than an
   * unreadable level, and the two must not be confused: one is the clearest
   * possible blank, the other is a measurement that failed.
   */
  noAudioStream: boolean;
}

/**
 * Walk the whole segment's audio, stopping at the first chunk that clears the
 * speech floor.
 *
 * The early exit is what keeps this cheap where it matters: a lecture with
 * someone talking from the start settles on the first chunk, in a fraction of a
 * second. Only a genuinely dead segment pays for the full scan.
 */
async function scanAudio(videoPath: string, durationSeconds: number): Promise<AudioScan> {
  const { audioChunkSeconds, speechFloorDb } = CONFIG.blankDetection;

  let loudestDb: number | null = null;
  let loudestAt: number | null = null;
  let sawAudioStream = false;

  for (let at = 0; at < durationSeconds; at += audioChunkSeconds) {
    // Never let the trailing remainder go unmeasured — a lecture that starts in
    // the last seconds of a segment lives exactly there. Anything shorter than a
    // second is measurement noise rather than content.
    const length = Math.min(audioChunkSeconds, durationSeconds - at);
    if (length < 1) break;

    const { level, hasAudioStream } = await chunkLevel(videoPath, at, length);
    if (hasAudioStream) sawAudioStream = true;

    // No audio track means every chunk reads the same way, so stop after the
    // first rather than walking a whole segment to learn it thirty times.
    if (!hasAudioStream && level === null) {
      return { loudestDb, loudestAt, speechFound: false, noAudioStream: !sawAudioStream };
    }
    if (level === null) continue;

    if (loudestDb === null || level > loudestDb) {
      loudestDb = level;
      loudestAt = at;
    }
    if (level > speechFloorDb) {
      return { loudestDb, loudestAt, speechFound: true, noAudioStream: false };
    }
  }

  return { loudestDb, loudestAt, speechFound: false, noAudioStream: !sawAudioStream };
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
    blank: false, deadFraction: 0, loudestDb: null, loudestAt: null, probes: [], summary,
  });

  // Too short to sample meaningfully, and too cheap to be worth skipping anyway.
  if (durationSeconds < probeSeconds * 2) {
    return notBlank("too short to analyse");
  }

  let audio: AudioScan;
  const probes: ProbeResult[] = [];
  try {
    // Audio first. It is the cheaper signal — no video decode — and it settles a
    // lecture with someone talking in a fraction of a second, which skips the
    // visual pass entirely. That matters most for slide-based lectures, where
    // the picture is static throughout and the visual pass would run all its
    // probes before concluding nothing.
    audio = await scanAudio(videoPath, durationSeconds);
    if (audio.speechFound) {
      return {
        blank: false,
        deadFraction: 0,
        loudestDb: audio.loudestDb,
        loudestAt: audio.loudestAt,
        probes: [],
        summary: `speech at ${formatClock(audio.loudestAt ?? 0)} (${audio.loudestDb?.toFixed(1)}dB)`,
      };
    }

    // Nobody spoke. Now ask whether anything moved.
    const usable = durationSeconds - probeSeconds;
    if (usable <= 0) return notBlank("too short to analyse");

    for (let i = 0; i < probeCount; i++) {
      const at = (usable * i) / Math.max(1, probeCount - 1);
      const probe = await probeAt(videoPath, at, probeSeconds);
      probes.push(probe);

      // One probe with motion settles it, because blankness requires every probe
      // to be dead. On a recording of advancing slides this stops at the first.
      const dead = probe.black >= probe.length * coverage || probe.frozen >= probe.length * coverage;
      if (!dead) {
        return notBlank(`picture changes at ${formatClock(at)}`);
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
  const deadFraction = deadCount / probes.length;

  // A null level with an audio track present means nothing could be measured,
  // which is not evidence of quiet. Refusing to call that blank costs one wasted
  // upload; the other way round discards a lecture on a decode hiccup.
  const { loudestDb, loudestAt, noAudioStream } = audio;
  const measuredQuiet = loudestDb !== null || noAudioStream;
  const blank = deadFraction === 1 && measuredQuiet;

  // The measured level is always reported, blank or not. It is the number to
  // move speechFloorDb against when a recording lands on the wrong side.
  const level = noAudioStream
    ? "no audio track"
    : loudestDb === null
      ? "level unreadable"
      : `loudest ${loudestDb.toFixed(1)}dB`;
  const summary = blank
    ? `nothing across ${formatClock(durationSeconds)} — picture never changes, ${level}`
    : `${deadCount}/${probes.length} probes visually dead, ${level}`;

  return { blank, deadFraction, loudestDb, loudestAt, probes, summary };
}

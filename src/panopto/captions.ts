/**
 * Panopto's captions, fetched as SRT and stored as WebVTT.
 *
 * Endpoint confirmed by probe (scripts/probe-panopto-captions.ts): the viewer
 * itself GETs
 *   /Panopto/Pages/Transcription/GenerateSRT.ashx?id=<GUID>&language=<n>
 * for language 0 and then 1, so this tries the same sequence and takes the first
 * that returns anything. On this tenant 0 comes back 200 with an empty body and
 * 1 carries the auto-generated English transcript — but which slot is populated
 * is a property of the recording, not of the tenant, so neither is hardcoded.
 *
 * Fetched from inside the authenticated browser context rather than with a bare
 * request: the endpoint is session-cookie gated, and the browser is where the
 * session already lives.
 *
 * Stored as WebVTT, which is the only caption format a <track> element accepts,
 * and kept in the video cache beside the recording it belongs to — swept with it
 * when UniNotes next starts or stops. A transcript is small enough that keeping
 * it would cost nothing, but it is a copy of something that lives on Panopto,
 * and one rule is easier to hold than two: the notes are yours and permanent,
 * anything fetched back from Panopto is temporary.
 */

import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import { videoCacheDir, safeCacheId } from "../utils/videoCache.js";
import { panoptoBaseUrl, viewerUrl } from "./endpoints.js";

/**
 * Panopto opens an auto-generated transcript with a disclaimer glued to the
 * first line of speech. It isn't speech, and left in it burns four seconds of
 * subtitle over the opening of the lecture — so it comes out here and the
 * Transcript tab says the same thing once, in a better place.
 */
const AUTO_BANNER = /\[Auto-generated transcript\.[^\]]*\]\s*/gi;

/** Where a lecture's transcript sits in the cache. Null for an unusable id. */
export function captionsPath(lectureId: string): string | null {
  const id = safeCacheId(lectureId);
  return id ? path.join(videoCacheDir(), `${id}.vtt`) : null;
}

export function hasCaptions(lectureId: string): boolean {
  const file = captionsPath(lectureId);
  if (!file) return false;
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * SRT → WebVTT.
 *
 * The formats are near-identical: a header, and a decimal comma that has to
 * become a full stop. Cue numbers are legal in VTT and are kept, because they
 * make a malformed file far easier to read when something does go wrong.
 */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r\n/g, "\n")
    .replace(AUTO_BANNER, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Seconds from "HH:MM:SS.mmm". */
function cueTime(value: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return NaN;
  return (
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000
  );
}

/**
 * Parse WebVTT into cues.
 *
 * Deliberately forgiving: a cue whose timing line won't parse is skipped rather
 * than aborting the file, because one malformed cue in nine hundred should cost
 * you that line and nothing else.
 */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.replace(/\r\n/g, "\n").split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    if (/^WEBVTT/.test(lines[0])) continue;

    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;

    const [from, to] = lines[timingIndex].split("-->");
    const start = cueTime((from ?? "").trim());
    // The end can carry positioning settings after the timestamp; take the time.
    const end = cueTime((to ?? "").trim().split(/\s+/)[0] ?? "");
    if (!Number.isFinite(start)) continue;

    const text = lines.slice(timingIndex + 1).join(" ").trim();
    if (text.length === 0) continue;

    cues.push({ start, end: Number.isFinite(end) ? end : start, text });
  }

  return cues;
}

/** Seconds → "HH:MM:SS.mmm", WebVTT's own shape. */
function vttStamp(seconds: number): string {
  const whole = Math.max(0, seconds);
  const ms = Math.round((whole % 1) * 1000);
  const total = Math.floor(whole);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}.${pad(ms, 3)}`;
}

const STAMP = /\d{2}:\d{2}:\d{2}[.,]\d{1,3}/g;

/**
 * Move every cue in a transcript later by `seconds`.
 *
 * Panopto sometimes trims the front of a recording for playback and cuts the
 * transcript to the trimmed version, while the file you can download is the
 * untrimmed original. The two then disagree by however much was cut — a few
 * seconds on most, minutes on some — and since every timestamp in the notes and
 * every span in a highlights reel is a transcript time, that offset is wrong
 * everywhere at once, not just in the subtitles.
 *
 * Applied here, on the way out, rather than to the cached file: the transcript
 * is Panopto's copy and gets swept and refetched, so editing it in place would
 * lose the correction on the next fetch. The stored number is the correction;
 * this is the one place it is spent.
 *
 * Only timing lines are touched. A timestamp written out inside a cue's text —
 * a lecturer reading one aloud — is text, not timing.
 */
export function shiftVtt(vtt: string, seconds: number): string {
  if (!Number.isFinite(seconds) || Math.abs(seconds) < 0.001) return vtt;
  return vtt
    .split("\n")
    .map((line) =>
      line.includes("-->")
        ? line.replace(STAMP, (stamp) => vttStamp(cueTime(stamp) + seconds))
        : line,
    )
    .join("\n");
}

/**
 * Fetch one recording's captions through an already-authenticated context.
 *
 * Returns null when the recording simply has none — a perfectly ordinary state
 * for a lecture Panopto hasn't transcribed, and not an error.
 */
export async function fetchCaptions(
  context: BrowserContext,
  lectureId: string,
): Promise<string | null> {
  const base = panoptoBaseUrl();
  const page = context.pages()[0] || (await context.newPage());

  // The endpoint answers to the session cookie, and a page on the tenant's own
  // origin is the simplest place that has one.
  if (!page.url().startsWith(base)) {
    await page.goto(viewerUrl(lectureId), {
      timeout: CONFIG.panopto.navigationTimeout,
      waitUntil: "domcontentloaded",
    });
  }

  for (const language of CONFIG.panopto.captionLanguages) {
    const url = `${base}/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${lectureId}&language=${language}`;
    const srt = await page.evaluate(async (target) => {
      try {
        const res = await fetch(target, { credentials: "include" });
        if (!res.ok) return "";
        return await res.text();
      } catch {
        return "";
      }
    }, url);

    // A populated transcript always has a timing line; a 200 with an empty body
    // means "this language slot is unused", which is not a failure.
    if (srt.trim().length > 0 && srt.includes("-->")) return srtToVtt(srt);
  }

  return null;
}

/** Fetch and cache captions for one lecture. Returns the path, or null. */
export async function saveCaptions(
  context: BrowserContext,
  lectureId: string,
): Promise<string | null> {
  const dest = captionsPath(lectureId);
  if (!dest) return null;

  const vtt = await fetchCaptions(context, lectureId);
  if (!vtt) return null;

  fs.mkdirSync(videoCacheDir(), { recursive: true });
  fs.writeFileSync(dest, vtt, "utf-8");
  log.info(`Captions cached: ${dest}`);
  return dest;
}

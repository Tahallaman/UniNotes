/**
 * Streaming a lecture's video file to the player in the control panel.
 *
 * Why the video is served from here at all, rather than embedding Panopto:
 * Panopto's pages send `frame-ancestors 'self' https:`, so they will frame from
 * an https origin but not from `http://127.0.0.1`, and an embedded player would
 * additionally need a Panopto sign-in in whichever browser profile happens to be
 * showing the control panel. Even when it works, the embed API only exposes a
 * polled `getCurrentTime()`. A local file gives exact seeking, works offline,
 * and needs no third party — so the player reads `lecture.<ext>` out of the
 * lecture folder and this module hands it over.
 *
 * Range support is the whole point. Without it Chrome will still play the file,
 * but it cannot seek: dragging the scrubber restarts from zero, which is
 * precisely the interaction the notes sync is built around.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { listLectures } from "./library.js";
import { assertInsideLectures } from "./mutations.js";
import { cachedVideoPath } from "../utils/videoCache.js";
import { captionsPath, shiftVtt } from "../panopto/captions.js";

/** Extensions checked for, in the order they're preferred. */
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mkv", ".mov", ".avi"];

/**
 * Only types a browser will actually play get a real content-type. An .mkv or
 * .avi is served as a stream so the request still succeeds and the player can
 * report "can't play this" itself, rather than the server pretending it's mp4
 * and the failure surfacing as a decode error with no explanation.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/**
 * Absolute path to a lecture's video, or null.
 *
 * Two places, in this order:
 *
 *   1. The video cache under temp/, where a fetched Panopto recording lives
 *      until UniNotes next starts or stops.
 *   2. The lecture folder, where a *local* video is archived by the Incoming
 *      pipeline. That one is your own file, not a copy of something on Panopto,
 *      so it is never swept and is playable for as long as you keep it.
 *
 * Neither path comes from the request: the id and the folder are re-derived from
 * the library, the folder is re-checked against Lectures/, and the filename is
 * fixed by convention — so there is nothing here to traverse out of.
 */
export function videoPathFor(key: string): string | null {
  const entry = listLectures().find((e) => e.key === key);
  if (!entry) return null;

  const cached = entry.id ? cachedVideoPath(entry.id) : null;
  if (cached) return cached;

  if (!entry.lectureDir) return null;
  let dir: string;
  try {
    dir = assertInsideLectures(entry.lectureDir);
  } catch {
    return null;
  }

  for (const ext of VIDEO_EXTENSIONS) {
    const candidate = path.join(dir, `lecture${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Serve a lecture's transcript as WebVTT.
 *
 * Same origin as the page, which matters: a <track> from another origin needs
 * CORS headers Panopto doesn't send, and is the reason the file is fetched and
 * stored rather than linked.
 *
 * The lecture's caption offset is applied on the way out, so what a <track>
 * receives is already in the file's own clock and the browser's cue timing needs
 * no correcting. Everything else in the player converts between the two frames
 * itself; this is the one consumer that can't.
 */
export function serveCaptions(res: http.ServerResponse, key: string): void {
  const entry = listLectures().find((e) => e.key === key);
  // The filename is derived from the lecture's own id, never from the request.
  const file = entry?.id ? captionsPath(entry.id) : null;
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("No transcript for that lecture.");
    return;
  }

  let body: Buffer;
  try {
    const text = fs.readFileSync(file, "utf-8");
    body = Buffer.from(shiftVtt(text, entry?.captionOffset ?? 0), "utf-8");
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("No transcript for that lecture.");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/vtt; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** `bytes=START-END` → offsets, clamped to the file. Null when unparseable. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  // "bytes=-500" means the last 500 bytes, not "from 0 to 500". Getting this
  // backwards serves the wrong part of the file with a 206 saying otherwise.
  if (rawStart === "") {
    const length = parseInt(rawEnd, 10);
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = rawEnd === "" ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/**
 * Serve one lecture's video, honouring a Range header.
 *
 * Responds 404 when there is no video on disk; the player treats that as "offer
 * to fetch it" rather than an error, so it must stay distinguishable from a
 * genuine failure.
 */
export function serveVideo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  key: string,
): void {
  const filePath = videoPathFor(key);
  if (!filePath) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("No video file for that lecture.");
    return;
  }

  const size = fs.statSync(filePath).size;
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const rangeHeader = req.headers.range;

  // A HEAD is how some players ask for the length before committing to a fetch.
  if (req.method === "HEAD") {
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": String(size),
      "accept-ranges": "bytes",
    });
    res.end();
    return;
  }

  if (!rangeHeader) {
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": String(size),
      // Advertised even on the full response: it's how the player learns it may
      // seek at all, and without it Chrome disables the scrubber.
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const range = parseRange(rangeHeader, size);
  if (!range) {
    res.writeHead(416, { "content-range": `bytes */${size}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    "content-type": contentType,
    "content-length": String(range.end - range.start + 1),
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });

  const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
  // Seeking aborts the in-flight range mid-stream, which surfaces here as a
  // premature close. Nothing is wrong; just let the stream go.
  stream.on("error", () => res.end());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

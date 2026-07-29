/**
 * Whatever was fetched back from Panopto, held only while you're watching.
 *
 * The player needs a local file — Panopto's pages send
 * `frame-ancestors 'self' https:` and so refuse to embed in a page served over
 * http://127.0.0.1 — but a lecture recording is the largest thing this tool
 * touches, and a semester of them beside the notes is tens of gigabytes that
 * nothing ever cleans up.
 *
 * So they live in a cache under temp/ that is emptied when the control panel
 * starts and again when it stops. Fetching one back takes seconds; keeping one
 * forever costs a gigabyte. Transcripts ride along in the same cache: a `.vtt`
 * is small enough that keeping it would cost nothing, but it is just as much a
 * copy of something on Panopto, and one rule is easier to hold than two. That
 * makes the storage story a sentence long: your notes are permanent, anything
 * fetched back from Panopto is not.
 *
 * Deliberately keyed by lecture id rather than by folder. A cached file is not
 * part of a lecture's contents — it is a temporary copy of something that lives
 * on Panopto — and putting it in the lecture folder is what made it look
 * permanent enough to leave lying around.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";

/** Extensions a download can arrive with, preferred in this order. */
const EXTENSIONS = [".mp4", ".webm", ".mov", ".mkv", ".avi"];

/**
 * Everything the sweep is allowed to remove.
 *
 * Transcripts live here too — a `.vtt` is a copy of something on Panopto just as
 * much as the recording is, and one rule ("anything fetched back from Panopto is
 * temporary") is easier to hold than two.
 */
const SWEEPABLE = [...EXTENSIONS, ".vtt"];

/** An id from the database, narrowed to what is safe as a filename. */
export function safeCacheId(lectureId: string): string | null {
  return /^[A-Za-z0-9._-]{1,128}$/.test(lectureId) ? lectureId : null;
}

export function videoCacheDir(): string {
  return CONFIG.paths.videoCache;
}

/** The cached recording for a lecture, or null if there isn't one. */
export function cachedVideoPath(lectureId: string): string | null {
  const id = safeCacheId(lectureId);
  if (!id) return null;
  for (const ext of EXTENSIONS) {
    const candidate = path.join(videoCacheDir(), `${id}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Move a downloaded file into the cache and return where it landed.
 *
 * Falls back to copy+delete because the download lands in temp/ and the cache
 * may be on a different volume if temp/ has been redirected.
 */
export function cacheVideo(srcPath: string, lectureId: string): string | null {
  const id = safeCacheId(lectureId);
  if (!id) return null;

  const dir = videoCacheDir();
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(srcPath).toLowerCase() || ".mp4";
  const destPath = path.join(dir, `${id}${ext}`);
  try {
    fs.renameSync(srcPath, destPath);
  } catch {
    fs.copyFileSync(srcPath, destPath);
    fs.rmSync(srcPath, { force: true });
  }
  return destPath;
}

export interface CacheSweep {
  files: number;
  bytes: number;
}

/**
 * Empty the cache — recordings and transcripts alike.
 *
 * Only files directly inside the cache directory, and only ones whose extension
 * is on the list: a sweep that recursed or matched anything would be a `rm -rf`
 * pointed at a configurable path, which is not a thing to run twice per session.
 */
export function clearVideoCache(): CacheSweep {
  const dir = videoCacheDir();
  const swept: CacheSweep = { files: 0, bytes: 0 };
  if (!fs.existsSync(dir)) return swept;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!SWEEPABLE.includes(path.extname(entry.name).toLowerCase())) continue;

    const filePath = path.join(dir, entry.name);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      // Gone already, or unreadable. Still worth attempting the delete.
    }
    try {
      fs.rmSync(filePath, { force: true });
      swept.files++;
      swept.bytes += size;
    } catch {
      // Most likely still open in the browser's media stack. It'll go on the
      // next sweep; failing the shutdown over it would be worse.
    }
  }

  return swept;
}

/** What's in the cache right now, for the status panel. */
export function videoCacheSize(): CacheSweep {
  const dir = videoCacheDir();
  const total: CacheSweep = { files: 0, bytes: 0 };
  if (!fs.existsSync(dir)) return total;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // Videos only: this figure is reported as disk used by recordings, and a
    // handful of kilobytes of transcript would only make it read as noise.
    if (!EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    try {
      total.bytes += fs.statSync(path.join(dir, entry.name)).size;
      total.files++;
    } catch {
      // Ignore: a file that vanished between readdir and stat isn't there to report.
    }
  }
  return total;
}

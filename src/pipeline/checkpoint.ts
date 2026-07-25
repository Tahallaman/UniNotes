/**
 * Per-part checkpoints so an interrupted lecture resumes instead of restarting.
 *
 * A 2-hour lecture is 8 parts. Losing part 8 to a timeout used to mean
 * regenerating parts 1-7 as well — a long, and on the API path expensive, redo.
 * Each part's markdown is written to disk as soon as it succeeds, so the next
 * run only does what's actually missing.
 *
 * Checkpoints are keyed by a fingerprint of the source video and the split
 * settings. Change the video or segmentSeconds and the old checkpoint is
 * discarded rather than silently mixed with parts from a different split.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG } from "../../config.js";
import { log, type LogContext } from "../utils/logger.js";
import type { ParsedActions } from "../notes/parser.js";

const CHECKPOINT_ROOT = path.join(CONFIG.paths.temp, "checkpoints");

interface Manifest {
  fingerprint: string;
  totalParts: number;
  provider: string;
  /** Part number (1-based) → chat URL, for parts already completed. */
  chatUrls: Record<string, string>;
  actions?: ParsedActions | null;
  updatedAt: string;
}

function safeId(lectureId: string): string {
  return lectureId.replace(/[^\w.-]+/g, "_").slice(0, 100) || "lecture";
}

function dirFor(lectureId: string): string {
  return path.join(CHECKPOINT_ROOT, safeId(lectureId));
}

function manifestPath(lectureId: string): string {
  return path.join(dirFor(lectureId), "manifest.json");
}

function partPath(lectureId: string, partNum: number): string {
  return path.join(dirFor(lectureId), `part-${String(partNum).padStart(2, "0")}.md`);
}

/**
 * Identifies this exact split of this exact video. Uses size + mtime rather than
 * hashing the file — lecture videos are hundreds of MB and re-hashing them on
 * every run would cost more than the checkpoint saves.
 */
export function computeFingerprint(
  videoPath: string,
  totalParts: number,
  provider: string,
): string {
  let stat = "missing";
  try {
    const s = fs.statSync(videoPath);
    stat = `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    // Source already moved/deleted — fingerprint on the path alone.
  }
  return createHash("md5")
    .update([videoPath, stat, CONFIG.segmentSeconds, totalParts, provider].join("|"))
    .digest("hex");
}

export interface LoadedCheckpoint {
  /** Part number (1-based) → markdown already generated. */
  parts: Map<number, string>;
  chatUrls: Map<number, string>;
  actions: ParsedActions | null;
}

/**
 * Load usable checkpoint data, or an empty result if none matches.
 * A mismatched fingerprint clears the directory so stale parts can't leak into
 * a later run.
 */
export function loadCheckpoint(
  lectureId: string,
  fingerprint: string,
  ctx?: LogContext,
): LoadedCheckpoint {
  const empty: LoadedCheckpoint = { parts: new Map(), chatUrls: new Map(), actions: null };

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath(lectureId), "utf-8")) as Manifest;
  } catch {
    return empty;
  }

  if (manifest.fingerprint !== fingerprint) {
    log.info("Checkpoint is for a different video/split — discarding it.", ctx);
    clearCheckpoint(lectureId);
    return empty;
  }

  const parts = new Map<number, string>();
  for (let i = 1; i <= manifest.totalParts; i++) {
    try {
      const content = fs.readFileSync(partPath(lectureId, i), "utf-8");
      if (content.trim().length > 0) parts.set(i, content);
    } catch {
      // Not done yet — it'll be generated this run.
    }
  }

  const chatUrls = new Map<number, string>();
  for (const [key, value] of Object.entries(manifest.chatUrls ?? {})) {
    chatUrls.set(Number(key), value);
  }

  if (parts.size > 0) {
    log.info(`Resuming from checkpoint: ${parts.size}/${manifest.totalParts} parts already done.`, ctx);
  }

  return { parts, chatUrls, actions: manifest.actions ?? null };
}

/** Persist one finished part. Best-effort: a checkpoint failure must not fail the run. */
export function savePart(
  lectureId: string,
  fingerprint: string,
  totalParts: number,
  provider: string,
  partNum: number,
  markdown: string,
  chatUrl: string,
): void {
  try {
    fs.mkdirSync(dirFor(lectureId), { recursive: true });
    fs.writeFileSync(partPath(lectureId, partNum), markdown, "utf-8");

    let manifest: Manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath(lectureId), "utf-8")) as Manifest;
      if (manifest.fingerprint !== fingerprint) throw new Error("stale");
    } catch {
      manifest = {
        fingerprint,
        totalParts,
        provider,
        chatUrls: {},
        actions: null,
        updatedAt: new Date().toISOString(),
      };
    }

    manifest.chatUrls[String(partNum)] = chatUrl;
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath(lectureId), JSON.stringify(manifest, null, 2), "utf-8");
  } catch (err) {
    log.warn(`Could not write checkpoint for part ${partNum}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Persist the whole-lecture actions block parsed from the final part. */
export function saveActions(lectureId: string, actions: ParsedActions | null): void {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath(lectureId), "utf-8")) as Manifest;
    manifest.actions = actions;
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath(lectureId), JSON.stringify(manifest, null, 2), "utf-8");
  } catch {
    // No manifest (single-part lecture, or checkpointing disabled) — harmless.
  }
}

/** Remove a lecture's checkpoint once its notes are safely written. */
export function clearCheckpoint(lectureId: string): void {
  try {
    fs.rmSync(dirFor(lectureId), { recursive: true, force: true });
  } catch {
    // Leftover directory is harmless; the fingerprint check guards correctness.
  }
}

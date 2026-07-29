/**
 * Find and regenerate missing pretty notes.
 *
 * Prettifying is deliberately non-fatal — the raw notes are the valuable artefact
 * and a formatting failure must never lose them. The cost of that choice is that
 * a failed pretty step would otherwise be forgotten, so every entry point sweeps
 * for lecture.raw.md files lacking a lecture.pretty.md sibling and retries them.
 *
 * That makes the recovery self-healing: whatever failed last night is picked up
 * on the next run with no flags and no manual bookkeeping.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import { mapWithLimitSettled } from "../utils/limit.js";
import { prettifyNotes } from "../notes/prettifier.js";
import { writePrettyNotes } from "../notes/writer.js";
import { syncToWorkspace } from "../utils/workspaceSync.js";
import type { NotesProvider } from "../utils/uploaderMode.js";

export interface PendingPretty {
  lectureDir: string;
  rawPath: string;
  prettyPath: string;
  courseCode: string;
  label: string;
}

/** Every lecture with raw notes but no pretty notes (or all of them, with `force`). */
export function findPendingPretty(force = false): PendingPretty[] {
  const pending: PendingPretty[] = [];
  if (!fs.existsSync(CONFIG.paths.lectures)) return pending;

  for (const course of fs.readdirSync(CONFIG.paths.lectures)) {
    const courseDir = path.join(CONFIG.paths.lectures, course);
    if (!safeIsDirectory(courseDir)) continue;

    for (const lecture of fs.readdirSync(courseDir)) {
      const lectureDir = path.join(courseDir, lecture);
      if (!safeIsDirectory(lectureDir)) continue;

      const rawPath = path.join(lectureDir, "lecture.raw.md");
      const prettyPath = path.join(lectureDir, "lecture.pretty.md");

      if (fs.existsSync(rawPath) && (force || !fs.existsSync(prettyPath))) {
        pending.push({
          lectureDir,
          rawPath,
          prettyPath,
          courseCode: course,
          label: `${course}/${lecture}`,
        });
      }
    }
  }

  return pending;
}

export interface BackfillResult {
  done: number;
  errors: number;
  total: number;
}

/**
 * Prettify each pending lecture, concurrently, writing and syncing as it goes.
 * Individual failures are reported but never abort the sweep.
 */
export async function backfillPretty(opts: {
  provider: NotesProvider;
  force?: boolean;
  entries?: PendingPretty[];
  onProgress?: (label: string, phase: "start" | "done" | "error", detail?: string) => void;
}): Promise<BackfillResult> {
  const entries = opts.entries ?? findPendingPretty(opts.force);
  if (entries.length === 0) return { done: 0, errors: 0, total: 0 };

  const outcomes = await mapWithLimitSettled(
    entries,
    CONFIG.concurrency.lectures,
    async (entry) => {
      opts.onProgress?.(entry.label, "start");

      const pretty = await prettifyNotes(entry.rawPath, {
        provider: opts.provider,
        ctx: { label: entry.label },
      });
      writePrettyNotes(entry.lectureDir, pretty);

      try {
        if (CONFIG.workspace.syncOnWrite) {
          syncToWorkspace(entry.courseCode, entry.prettyPath);
        }
      } catch (syncErr) {
        log.warn(
          `Workspace sync failed for ${entry.label}: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
        );
      }

      opts.onProgress?.(entry.label, "done", `${pretty.length} chars`);
    },
  );

  let done = 0;
  let errors = 0;
  outcomes.forEach((outcome, i) => {
    if (outcome.ok) {
      done++;
      return;
    }
    errors++;
    const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    opts.onProgress?.(entries[i].label, "error", msg);
    log.warn(`Pretty backfill failed for ${entries[i].label}: ${msg}`);
  });

  return { done, errors, total: entries.length };
}

function safeIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

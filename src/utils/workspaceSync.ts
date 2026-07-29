/**
 * Keep a second copy of each pretty note in the folder you actually study from.
 *
 * The destination comes from the templates in settings, via
 * src/notes/organise.ts — the same code the control panel previews and the
 * Exports job uses, so what the preview promised is what lands here.
 *
 * There is no "Unsorted Lectures" any more. A lecture whose date we couldn't
 * work out simply doesn't get a week folder: the segment drops out and the note
 * lands one level up, beside the weeks. A folder named after the failure was
 * only ever a place for notes to go and be forgotten.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG } from "../../config.js";
import { log } from "./logger.js";
import { destinationFor, type LectureFacts } from "../notes/organise.js";

function fileHash(filePath: string): string {
  return createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

function isUpToDate(src: string, dest: string): boolean {
  if (!fs.existsSync(dest)) return false;
  const srcStat = fs.statSync(src);
  const destStat = fs.statSync(dest);
  if (srcStat.mtimeMs < destStat.mtimeMs) return true;
  if (srcStat.mtimeMs > destStat.mtimeMs) return false;
  if (srcStat.size !== destStat.size) return false;
  return fileHash(src) === fileHash(dest);
}

/**
 * Resolve where one lecture's pretty note belongs in the workspace folder.
 *
 * Exported so the sync job and the preview endpoint can ask the same question
 * without copying anything.
 */
export function workspaceDestination(facts: LectureFacts): { dir: string; file: string } {
  const destination = destinationFor(
    facts,
    {
      folderTemplate: CONFIG.workspace.folderTemplate,
      fileTemplate: CONFIG.workspace.fileTemplate || CONFIG.naming.fileTemplate,
    },
    CONFIG.terms.list,
    CONFIG.terms.enabled,
  );

  const dir = path.join(CONFIG.workspace.root, ...destination.segments);
  return { dir, file: path.join(dir, destination.filename) };
}

export interface SyncOptions {
  /** Title as it was recorded, for date parsing and the {title} token. */
  title?: string;
  recordedAt?: string | null;
  dateOverride?: string | null;
}

/**
 * Copy one pretty note into the workspace folder.
 *
 * Returns the destination path when something was written, null when the copy
 * was skipped or the feature is off, so callers can report a count.
 */
export function syncToWorkspace(
  courseCode: string,
  prettyFilePath: string,
  options: SyncOptions = {},
): string | null {
  // Checked here rather than at each of the call sites, so turning it off
  // can't be missed by one of them.
  if (!CONFIG.workspace.enabled) return null;

  if (!fs.existsSync(prettyFilePath)) {
    log.warn(`[workspace-sync] Pretty file not found: ${prettyFilePath}`);
    return null;
  }

  // The lecture folder is named after the title, and is the only source of one
  // when a caller doesn't pass it.
  const title = options.title ?? path.basename(path.dirname(prettyFilePath));

  const { dir, file } = workspaceDestination({
    title,
    courseCode,
    recordedAt: options.recordedAt ?? null,
    dateOverride: options.dateOverride ?? null,
  });

  if (isUpToDate(prettyFilePath, file)) {
    log.info(`[workspace-sync] Already up-to-date: ${file}`);
    return null;
  }

  // Course and week folders are created rather than required to exist. The old
  // behaviour — write only into a course folder that was already there — is why
  // notes ended up pooled in a top-level Unsorted Lectures instead.
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(prettyFilePath, file);
  log.info(`[workspace-sync] Synced → ${file}`);
  return file;
}

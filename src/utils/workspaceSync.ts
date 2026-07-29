/**
 * Keep a second copy of each pretty note in another folder.
 *
 * Copies lecture.pretty.md into that folder's `<CourseCode>/Unsorted Lectures/`,
 * falling back to a top-level `Unsorted Lectures/` when the course folder doesn't
 * exist. Off entirely when `workspace.enabled` is false.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG } from "../../config.js";
import { log } from "./logger.js";
import { exportNameFor, legacyExportName, renameStaleExport } from "../notes/exportName.js";

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

export function syncToWorkspace(courseCode: string, prettyFilePath: string): void {
  // Checked here rather than at each of the four call sites, so turning it off
  // can't be missed by one of them.
  if (!CONFIG.workspace.enabled) return;

  const workspaceRoot = CONFIG.workspace.root;
  const unsortedFolder = CONFIG.workspace.unsortedFolder;

  if (!fs.existsSync(prettyFilePath)) {
    log.warn(`[workspace-sync] Pretty file not found: ${prettyFilePath}`);
    return;
  }

  // Determine destination: course folder if it exists, otherwise root fallback
  const courseDir = path.join(workspaceRoot, courseCode);
  const destDir = fs.existsSync(courseDir)
    ? path.join(courseDir, unsortedFolder)
    : path.join(workspaceRoot, unsortedFolder);

  // Named from the lecture folder, which is the recording's title, with the
  // lecture number moved to the front — see src/notes/exportName.ts.
  const lectureDir = path.dirname(prettyFilePath);
  const lectureTitle = path.basename(lectureDir);
  const destFilename = exportNameFor(courseCode, lectureDir);
  const destPath = path.join(destDir, destFilename);

  // A copy filed here under the old name is the same note. Rename it rather
  // than leave the folder holding both.
  if (fs.existsSync(destDir)) {
    const result = renameStaleExport(destDir, legacyExportName(lectureTitle), destFilename);
    if (result === "renamed") {
      log.info(`[workspace-sync] Renamed previous copy → ${destFilename}`);
    } else if (result === "conflict") {
      log.warn(
        `[workspace-sync] Both names exist in ${destDir}: "${legacyExportName(lectureTitle)}" ` +
          `and "${destFilename}". Left the old one alone — delete whichever you don't want.`,
      );
    }
  }

  // Skip if destination is already up-to-date
  if (isUpToDate(prettyFilePath, destPath)) {
    log.info(`[workspace-sync] Already up-to-date: ${destPath}`);
    return;
  }

  // Ensure destination directory exists
  fs.mkdirSync(destDir, { recursive: true });

  // Copy the file
  fs.copyFileSync(prettyFilePath, destPath);
  log.info(`[workspace-sync] Synced → ${destPath}`);
}

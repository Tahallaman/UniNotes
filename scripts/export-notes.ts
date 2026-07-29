/**
 * Export lecture notes into flat course-level folders.
 *
 * Usage:
 *   npx tsx scripts/export-notes.ts          # export both raw + pretty
 *   npx tsx scripts/export-notes.ts --raw    # raw only
 *   npx tsx scripts/export-notes.ts --pretty # pretty only
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncToWorkspace } from "../src/utils/workspaceSync.js";
import {
  exportNamesForCourse,
  legacyExportName,
  renameStaleExport,
} from "../src/notes/exportName.js";

const ROOT = path.resolve(import.meta.dirname!, "..");
const LECTURES_DIR = path.join(ROOT, "Lectures");
const EXPORTS_DIR = path.join(ROOT, "Exports");

const args = process.argv.slice(2);
const exportRaw = args.length === 0 || args.includes("--raw");
const exportPretty = args.length === 0 || args.includes("--pretty");

let scanned = 0;
let copied = 0;
let skipped = 0;
let renamed = 0;

function fileHash(filePath: string): string {
  return createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Returns true (skip copy) when the destination is already current:
 *   - dest exists AND src mtime <= dest mtime  (export is at least as new as source)
 * Falls back to content hash when mtimes are equal (e.g. FAT32 or copied files)
 * to avoid a redundant overwrite.
 */
function isUpToDate(src: string, dest: string): boolean {
  if (!fs.existsSync(dest)) return false;
  const srcMtime = fs.statSync(src).mtimeMs;
  const destMtime = fs.statSync(dest).mtimeMs;
  if (srcMtime < destMtime) return true;   // export is newer — keep it
  if (srcMtime > destMtime) return false;  // source is newer — overwrite
  // Equal mtimes: compare content to avoid a redundant copy
  const srcStat = fs.statSync(src);
  const destStat = fs.statSync(dest);
  if (srcStat.size !== destStat.size) return false;
  return fileHash(src) === fileHash(dest);
}

function copyIfNeeded(src: string, dest: string): void {
  scanned++;
  if (!fs.existsSync(src)) return;

  if (isUpToDate(src, dest)) {
    skipped++;
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied++;
  console.log(`COPIED: ${path.relative(ROOT, dest)}`);
}

/**
 * Move any copy exported under the pre-numbering name onto the new one.
 *
 * Without this, turning the numbering on means every note exists twice in the
 * folder you actually read — once under each scheme, with identical contents.
 * Renaming is confined to the exact name this script wrote before, so nothing
 * you filed or renamed yourself is touched.
 */
function migrateLegacyName(dir: string, lecture: string, destFilename: string): void {
  const result = renameStaleExport(dir, legacyExportName(lecture), destFilename);
  if (result === "renamed") {
    renamed++;
    console.log(`RENAMED: ${path.relative(ROOT, path.join(dir, destFilename))}`);
  } else if (result === "conflict") {
    console.warn(
      `LEFT BEHIND: ${path.relative(ROOT, path.join(dir, legacyExportName(lecture)))} ` +
        `— a file already exists under the new name; delete whichever you don't want.`,
    );
  }
}

// Walk Lectures/<Course>/<LectureTitle>/
for (const course of fs.readdirSync(LECTURES_DIR)) {
  const courseDir = path.join(LECTURES_DIR, course);
  if (!fs.statSync(courseDir).isDirectory()) continue;

  // Named a course at a time: a lecture whose title states no number is
  // numbered by where it falls among its siblings.
  const exportNames = exportNamesForCourse(course, courseDir);

  for (const lecture of fs.readdirSync(courseDir)) {
    const lectureDir = path.join(courseDir, lecture);
    if (!fs.statSync(lectureDir).isDirectory()) continue;

    const destFilename = exportNames.get(lecture) ?? legacyExportName(lecture);

    if (exportRaw) {
      const rawSrc = path.join(lectureDir, "lecture.raw.md");
      const rawDir = path.join(EXPORTS_DIR, "Raw", course);
      migrateLegacyName(rawDir, lecture, destFilename);
      copyIfNeeded(rawSrc, path.join(rawDir, destFilename));
    }

    if (exportPretty) {
      const prettySrc = path.join(lectureDir, "lecture.pretty.md");
      const prettyDir = path.join(EXPORTS_DIR, "Pretty", course);
      migrateLegacyName(prettyDir, lecture, destFilename);
      copyIfNeeded(prettySrc, path.join(prettyDir, destFilename));

      // Also sync to University workspace (non-fatal)
      try {
        syncToWorkspace(course, prettySrc);
      } catch (syncErr) {
        console.warn(`[SYNC] Workspace sync failed for ${course}/${lecture}: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
      }
    }
  }
}

console.log(
  `\nExport complete: ${scanned} scanned, ${copied} copied, ${skipped} up-to-date` +
    (renamed > 0 ? `, ${renamed} renamed` : ""),
);

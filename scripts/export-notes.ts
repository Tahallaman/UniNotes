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

const ROOT = path.resolve(import.meta.dirname!, "..");
const LECTURES_DIR = path.join(ROOT, "Lectures");
const EXPORTS_DIR = path.join(ROOT, "Exports");

const args = process.argv.slice(2);
const exportRaw = args.length === 0 || args.includes("--raw");
const exportPretty = args.length === 0 || args.includes("--pretty");

let scanned = 0;
let copied = 0;
let skipped = 0;

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

// Walk Lectures/<Course>/<LectureTitle>/
for (const course of fs.readdirSync(LECTURES_DIR)) {
  const courseDir = path.join(LECTURES_DIR, course);
  if (!fs.statSync(courseDir).isDirectory()) continue;

  for (const lecture of fs.readdirSync(courseDir)) {
    const lectureDir = path.join(courseDir, lecture);
    if (!fs.statSync(lectureDir).isDirectory()) continue;

    const destFilename = `${lecture}.md`;

    if (exportRaw) {
      const rawSrc = path.join(lectureDir, "lecture.raw.md");
      const rawDest = path.join(EXPORTS_DIR, "Raw", course, destFilename);
      copyIfNeeded(rawSrc, rawDest);
    }

    if (exportPretty) {
      const prettySrc = path.join(lectureDir, "lecture.pretty.md");
      const prettyDest = path.join(EXPORTS_DIR, "Pretty", course, destFilename);
      copyIfNeeded(prettySrc, prettyDest);

      // Also sync to University workspace (non-fatal)
      try {
        syncToWorkspace(course, prettySrc);
      } catch (syncErr) {
        console.warn(`[SYNC] Workspace sync failed for ${course}/${lecture}: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
      }
    }
  }
}

console.log(`\nExport complete: ${scanned} scanned, ${copied} copied, ${skipped} up-to-date`);

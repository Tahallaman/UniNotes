/**
 * Copy lecture notes into Exports/.
 *
 * Exports/ only — the workspace copy is `scripts/sync-workspace.ts`, run
 * separately. They were one loop until the two destinations grew different
 * layouts, at which point "export" meaning two things made it impossible to
 * redo one without redoing the other.
 *
 * Usage:
 *   npx tsx scripts/export-notes.ts          # export both raw + pretty
 *   npx tsx scripts/export-notes.ts --raw    # raw only
 *   npx tsx scripts/export-notes.ts --pretty # pretty only
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG } from "../config.js";
import { listLectures } from "../src/gui/library.js";
import { destinationFor, lectureNumbersByCourse } from "../src/notes/organise.js";

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
  console.log(`COPIED: ${path.relative(CONFIG.rootDir, dest)}`);
}

// The library rather than a directory walk: it already merges the database with
// the disk, which is what gets a hand-corrected date onto a lecture whose folder
// name still says otherwise.
const entries = listLectures().filter((e) => e.lectureDir);
const numbers = lectureNumbersByCourse(
  entries.map((e) => ({ key: e.key, title: e.title, courseCode: e.courseCode, date: e.lectureDate })),
);

for (const entry of entries) {
  if (!entry.lectureDir) continue;

  const destination = destinationFor(
    {
      title: entry.title,
      courseCode: entry.courseCode,
      resolvedDate: entry.lectureDate,
      resolvedSource: entry.dateSource,
      lectureNumber: numbers.get(entry.key) ?? null,
    },
    {
      folderTemplate: CONFIG.exports.folderTemplate,
      fileTemplate: CONFIG.exports.fileTemplate || CONFIG.naming.fileTemplate,
    },
    CONFIG.terms.list,
    CONFIG.terms.enabled,
  );

  // Resolved once above, then rooted twice — Raw and Pretty are the same tree
  // with a different top, and deriving them separately invites them to drift.
  const place = (kind: "Raw" | "Pretty") =>
    path.join(CONFIG.paths.exports, kind, ...destination.segments, destination.filename);

  if (exportRaw) {
    copyIfNeeded(path.join(entry.lectureDir, "lecture.raw.md"), place("Raw"));
  }
  if (exportPretty) {
    copyIfNeeded(path.join(entry.lectureDir, "lecture.pretty.md"), place("Pretty"));
  }
}

console.log(`\nExport complete: ${scanned} scanned, ${copied} copied, ${skipped} up-to-date`);

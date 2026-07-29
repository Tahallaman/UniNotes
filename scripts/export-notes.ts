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
import {
  readLedger,
  writeLedger,
  moveRecorded,
  legacyPath,
  type Ledger,
} from "../src/notes/exportLedger.js";

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
  console.log(`COPIED: ${path.relative(CONFIG.rootDir, dest)}`);
}

/**
 * Move a note we wrote before onto the name we're writing now.
 *
 * Only files this script recorded, and only when the name has changed — see
 * src/notes/exportLedger.ts for why that restriction is the whole design.
 */
function migrate(root: string, ledger: Ledger, key: string, next: string, lectureDirName: string, courseCode: string): void {
  const recorded = ledger[key] ?? legacySeed(root, courseCode, lectureDirName);
  if (!recorded) return;

  const outcome = moveRecorded(root, recorded, next);
  if (outcome.kind === "moved") {
    renamed++;
    console.log(`RENAMED: ${outcome.from}  ->  ${outcome.to}`);
  } else if (outcome.kind === "blocked") {
    console.warn(
      `LEFT BEHIND: ${outcome.from} — something already sits at ${outcome.to}; ` +
        `delete whichever you don't want.`,
    );
  }
}

/** The pre-template name, but only if a file is really sitting under it. */
function legacySeed(root: string, courseCode: string, lectureDirName: string): string | null {
  const candidate = legacyPath(courseCode, lectureDirName);
  return fs.existsSync(path.join(root, candidate)) ? candidate : null;
}

// The library rather than a directory walk: it already merges the database with
// the disk, which is what gets a hand-corrected date onto a lecture whose folder
// name still says otherwise.
const entries = listLectures().filter((e) => e.lectureDir);
const numbers = lectureNumbersByCourse(
  entries.map((e) => ({ key: e.key, title: e.title, courseCode: e.courseCode, date: e.lectureDate })),
);

const roots = {
  Raw: path.join(CONFIG.paths.exports, "Raw"),
  Pretty: path.join(CONFIG.paths.exports, "Pretty"),
};
const ledgers = { Raw: readLedger(roots.Raw), Pretty: readLedger(roots.Pretty) };

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
  const relative = [...destination.segments, destination.filename].join("/");
  const lectureDirName = path.basename(entry.lectureDir);

  // Migrate before copying, or the copy lands at the new name first and the old
  // one is then a file we'd refuse to move onto an occupied path.
  const write = (kind: "Raw" | "Pretty", source: string) => {
    migrate(roots[kind], ledgers[kind], entry.key, relative, lectureDirName, entry.courseCode);
    copyIfNeeded(path.join(entry.lectureDir!, source), path.join(roots[kind], relative));
    // Recorded whether or not the copy was needed: the point is where the note
    // is, not whether this run is what put it there.
    ledgers[kind][entry.key] = relative;
  };

  if (exportRaw) write("Raw", "lecture.raw.md");
  if (exportPretty) write("Pretty", "lecture.pretty.md");
}

writeLedger(roots.Raw, ledgers.Raw);
writeLedger(roots.Pretty, ledgers.Pretty);

console.log(
  `\nExport complete: ${scanned} scanned, ${copied} copied, ${skipped} up-to-date` +
    (renamed > 0 ? `, ${renamed} renamed` : ""),
);

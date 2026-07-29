/**
 * Copy every pretty note into the workspace folder — the OneDrive/Obsidian
 * folder you actually study from.
 *
 * Separate from `scripts/export-notes.ts` on purpose. Exports/ is a local
 * mirror the tool owns and can rebuild; the workspace folder is *yours*, with
 * your own files in it, and the two want different layouts and different
 * moments. Nothing here deletes or moves anything already there.
 *
 * Usage:
 *   npx tsx scripts/sync-workspace.ts
 *   npx tsx scripts/sync-workspace.ts --dry-run   # report, write nothing
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { listLectures } from "../src/gui/library.js";
import { workspaceDestination, syncToWorkspace } from "../src/utils/workspaceSync.js";
import { lectureNumbersByCourse } from "../src/notes/organise.js";
import { readLedger, writeLedger, moveRecorded } from "../src/notes/exportLedger.js";

const dryRun = process.argv.slice(2).includes("--dry-run");

if (!CONFIG.workspace.enabled) {
  console.error(
    "The second copy is switched off. Turn on Settings → Second copy → Keep a second copy,\n" +
      "and set the folder it should write to.",
  );
  process.exit(1);
}

if (!CONFIG.workspace.root.trim()) {
  console.error("No workspace folder set — Settings → Second copy → Folder.");
  process.exit(1);
}

let copied = 0;
let upToDate = 0;
let missing = 0;
let undated = 0;
let renamed = 0;

const entries = listLectures().filter((e) => e.lectureDir);

// Where each note was last written, so a template change moves it instead of
// leaving a second copy beside it. See src/notes/exportLedger.ts.
const ledger = readLedger(CONFIG.workspace.root);

// Numbered across the whole library before anything is written: a lecture's
// number depends on its siblings, so it can't be worked out inside the loop.
const numbers = lectureNumbersByCourse(
  entries.map((e) => ({ key: e.key, title: e.title, courseCode: e.courseCode, date: e.lectureDate })),
);

for (const entry of entries) {
  if (!entry.lectureDir) continue;

  const prettyPath = path.join(entry.lectureDir, "lecture.pretty.md");
  if (!fs.existsSync(prettyPath)) {
    missing++;
    continue;
  }

  const facts = {
    title: entry.title,
    courseCode: entry.courseCode,
    resolvedDate: entry.lectureDate,
    resolvedSource: entry.dateSource,
    lectureNumber: numbers.get(entry.key) ?? null,
  };

  if (entry.lectureDate === null) undated++;

  const { file } = workspaceDestination(facts);
  const relative = path.relative(CONFIG.workspace.root, file).split(path.sep).join("/");

  if (dryRun) {
    console.log(`WOULD COPY: ${relative}`);
    const recorded = ledger[entry.key];
    if (recorded && recorded !== relative) console.log(`WOULD RENAME: ${recorded}  ->  ${relative}`);
    copied++;
    continue;
  }

  // Before the copy: afterwards the new name is occupied and the old one is a
  // file we'd refuse to move onto it.
  const recorded = ledger[entry.key];
  if (recorded) {
    const outcome = moveRecorded(CONFIG.workspace.root, recorded, relative);
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

  try {
    const written = syncToWorkspace(entry.courseCode, prettyPath, facts);
    ledger[entry.key] = relative;
    if (written) copied++;
    else upToDate++;
  } catch (err) {
    // One unwritable destination shouldn't abandon the rest of the run.
    console.warn(`FAILED: ${entry.title} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Not on a dry run: nothing moved, so recording where things are would be a
// claim about a folder this run deliberately didn't touch.
if (!dryRun) writeLedger(CONFIG.workspace.root, ledger);

console.log(
  `\n${dryRun ? "Dry run" : "Sync"} complete: ${copied} ${dryRun ? "to copy" : "copied"}, ` +
    `${upToDate} already current, ${missing} without pretty notes` +
    (renamed > 0 ? `, ${renamed} renamed` : ""),
);

if (undated > 0) {
  console.log(
    `${undated} lecture(s) had no date, so they skipped the week folder. ` +
      `Set one in the Library to file them.`,
  );
}

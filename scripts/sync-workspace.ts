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

for (const entry of listLectures()) {
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
  };

  if (entry.lectureDate === null) undated++;

  if (dryRun) {
    const { file } = workspaceDestination(facts);
    console.log(`WOULD COPY: ${path.relative(CONFIG.workspace.root, file)}`);
    copied++;
    continue;
  }

  try {
    const written = syncToWorkspace(entry.courseCode, prettyPath, facts);
    if (written) copied++;
    else upToDate++;
  } catch (err) {
    // One unwritable destination shouldn't abandon the rest of the run.
    console.warn(`FAILED: ${entry.title} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(
  `\n${dryRun ? "Dry run" : "Sync"} complete: ${copied} ${dryRun ? "to copy" : "copied"}, ` +
    `${upToDate} already current, ${missing} without pretty notes`,
);

if (undated > 0) {
  console.log(
    `${undated} lecture(s) had no date, so they skipped the week folder. ` +
      `Set one in the Library to file them.`,
  );
}

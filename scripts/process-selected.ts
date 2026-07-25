/**
 * Process (or just prettify) a specific set of lectures rather than everything
 * that happens to be pending.
 *
 * Usage:
 *   npx tsx scripts/process-selected.ts --selection=<file.json>
 *   npx tsx scripts/process-selected.ts --selection=<file.json> --pretty-only
 *
 * The selection is a JSON file, not a list of command-line arguments:
 *
 *   { "ids": ["<db id>", ...], "dirs": ["<absolute lecture dir>", ...] }
 *
 * Lecture titles routinely contain spaces, commas, brackets and em-dashes, and a
 * selection can be dozens of entries long. Passing those through a Windows
 * command line is a quoting problem with no good answer and a length limit
 * waiting behind it. A temp file has neither.
 *
 * `dirs` exists because the library is a union of the database and the disk:
 * lectures whose folders predate the current tracking have no row to reference,
 * but prettifying them is still a perfectly reasonable thing to ask for.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { withRetry } from "../src/utils/retry.js";
import { getDb, closeDb } from "../src/db/schema.js";
import { updateStatus, setError, type LectureRow } from "../src/db/tracker.js";
import { downloadLecture } from "../src/panopto/downloader.js";
import { processLecture } from "../src/pipeline/processLecture.js";
import { backfillPretty, type PendingPretty } from "../src/pipeline/prettyBackfill.js";
import { closeGeminiBrowser } from "../src/gemini/browserPool.js";
import { mapWithLimitSettled } from "../src/utils/limit.js";
import { resolveUploaderMode, resolvePrettyMode } from "../src/utils/uploaderMode.js";

const cliArgs = process.argv.slice(2);
const prettyOnly = cliArgs.includes("--pretty-only");
const providers = {
  notes: resolveUploaderMode(cliArgs),
  pretty: resolvePrettyMode(cliArgs),
};

interface Selection {
  ids?: string[];
  dirs?: string[];
}

function readSelection(): Selection {
  const arg = cliArgs.find((a) => a.startsWith("--selection="));
  if (!arg) {
    console.error("Missing --selection=<file.json>");
    process.exit(2);
  }
  const file = arg.slice("--selection=".length);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Selection;
    return { ids: parsed.ids ?? [], dirs: parsed.dirs ?? [] };
  } catch (err) {
    console.error(`Could not read selection file "${file}": ${(err as Error).message}`);
    process.exit(2);
  }
}

const selection = readSelection();

ensureDirectories();
getDb();

const db = getDb();

/** Rows for the selected ids, in the order the database returns them. */
function selectedRows(): LectureRow[] {
  const ids = selection.ids ?? [];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM lectures WHERE id IN (${placeholders})`)
    .all(...ids) as LectureRow[];
}

// ── Prettify-only mode ────────────────────────────────────────────────────────

if (prettyOnly) {
  const dirs = new Set(selection.dirs ?? []);
  for (const row of selectedRows()) {
    if (row.notes_file) dirs.add(row.notes_file);
  }

  const entries: PendingPretty[] = [];
  for (const dir of dirs) {
    const rawPath = path.join(dir, "lecture.raw.md");
    if (!fs.existsSync(rawPath)) {
      console.log(`[SKIP]  ${dir} — no lecture.raw.md to prettify`);
      continue;
    }
    entries.push({
      lectureDir: dir,
      rawPath,
      prettyPath: path.join(dir, "lecture.pretty.md"),
      courseCode: path.basename(path.dirname(dir)),
      label: `${path.basename(path.dirname(dir))}/${path.basename(dir)}`,
    });
  }

  if (entries.length === 0) {
    console.log("Nothing to prettify in the selection.");
    closeDb();
    process.exit(0);
  }

  console.log(`Prettifying ${entries.length} lecture(s) via ${providers.pretty}...\n`);

  try {
    const result = await backfillPretty({
      provider: providers.pretty,
      entries,
      onProgress: (label, phase, detail) => {
        if (phase === "start") console.log(`[START] ${label}`);
        if (phase === "done") console.log(`[DONE]  ${label} (${detail})`);
        if (phase === "error") console.error(`[ERROR] ${label}: ${detail}`);
      },
    });
    console.log(`\nComplete: ${result.done} prettified, ${result.errors} errors.`);
    if (result.errors > 0) process.exitCode = 1;
  } finally {
    await closeGeminiBrowser();
    closeDb();
  }
} else {
  // ── Full processing mode ────────────────────────────────────────────────────

  const rows = selectedRows();
  if (rows.length === 0) {
    console.log("None of the selected lectures are in the database — nothing to process.");
    closeDb();
    process.exit(0);
  }

  if (!acquireLock()) {
    console.error("Another UniNotes run holds the lock. Try again when it finishes.");
    closeDb();
    process.exit(1);
  }

  console.log(
    `Processing ${rows.length} selected lecture(s) — notes via ${providers.notes}, ` +
      `pretty via ${providers.pretty}, up to ${CONFIG.concurrency.lectures} at a time.\n`,
  );

  let done = 0;
  let errors = 0;

  try {
    const outcomes = await mapWithLimitSettled(rows, CONFIG.concurrency.lectures, async (row) => {
      const label = `${row.course_code}/${row.title}`;
      console.log(`[START] ${label}`);

      // A selected lecture may not have been downloaded yet — "process this one"
      // should mean the whole job, not fail because a prior step wasn't run.
      let videoPath = row.temp_file;
      if (!videoPath || !fs.existsSync(videoPath)) {
        if (row.source === "local") {
          throw new Error("Source video is missing — put it back in Incoming/ and use Process Incoming.");
        }
        console.log(`[GET]   ${label} — downloading`);
        updateStatus(row.id, "downloading");
        videoPath = await withRetry(() => downloadLecture(row), {
          label: `Download ${row.title}`,
          maxRetries: CONFIG.retry.maxRetries,
          delayMs: CONFIG.retry.delayMs,
        });
        updateStatus(row.id, "downloaded", { temp_file: videoPath });
      }

      await processLecture(
        {
          id: row.id,
          title: row.title,
          courseCode: row.course_code,
          videoPath,
          panoptoUrl: row.panopto_url,
          // Local videos keep the process-local convention: parts in temp/, and
          // the source archived into the lecture folder rather than deleted.
          partsDir: row.source === "local" ? CONFIG.paths.temp : undefined,
          onComplete: row.source === "local" ? "move" : "delete",
        },
        providers,
      );

      console.log(`[DONE]  ${label}`);
    });

    outcomes.forEach((outcome, i) => {
      if (outcome.ok) {
        done++;
        return;
      }
      errors++;
      const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      setError(rows[i].id, msg);
      console.error(`[ERROR] ${rows[i].course_code}/${rows[i].title}: ${msg}`);
    });
  } finally {
    await closeGeminiBrowser();
    releaseLock();
    closeDb();
  }

  console.log(`\nComplete: ${done} processed, ${errors} errors.`);
  if (errors > 0) process.exitCode = 1;
}

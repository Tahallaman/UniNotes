/**
 * Process manually downloaded lecture videos through the Gemini pipeline.
 *
 * Convention: drop video files in  Incoming/<CourseCode>/<LectureTitle>.mp4
 * Usage: npx tsx scripts/process-local.ts [--retry] [--uploader=api|browser] [--pretty=api|browser]
 *
 * Videos are processed concurrently (CONFIG.concurrency.lectures), then moved to:
 *   Lectures/<CourseCode>/<LectureTitle>/lecture.<ext>
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG } from "../config.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { getDb, closeDb } from "../src/db/schema.js";
import {
  insertLocalLecture,
  setError,
  resetStaleStatuses,
  type LocalLecture,
} from "../src/db/tracker.js";
import { processLecture } from "../src/pipeline/processLecture.js";
import { backfillPretty } from "../src/pipeline/prettyBackfill.js";
import { closeGeminiBrowser } from "../src/gemini/browserPool.js";
import { mapWithLimitSettled } from "../src/utils/limit.js";
import { resolveUploaderMode, resolvePrettyMode } from "../src/utils/uploaderMode.js";

const cliArgs = process.argv.slice(2);
const retryErrors = cliArgs.includes("--retry");
const providers = {
  notes: resolveUploaderMode(cliArgs),
  pretty: resolvePrettyMode(cliArgs),
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm"]);

interface PendingVideo {
  id: string;
  title: string;
  courseCode: string;
  videoPath: string;
}

function hashPath(p: string): string {
  return createHash("md5").update(p).digest("hex");
}

// ── Collect pending videos ────────────────────────────────────────────────────

const pending: PendingVideo[] = [];

if (!fs.existsSync(CONFIG.paths.incoming)) {
  console.log("Incoming/ directory does not exist yet. Nothing to process.");
  process.exit(0);
}

for (const courseCode of fs.readdirSync(CONFIG.paths.incoming)) {
  const courseDir = path.join(CONFIG.paths.incoming, courseCode);
  if (!fs.statSync(courseDir).isDirectory()) continue;

  for (const filename of fs.readdirSync(courseDir)) {
    const ext = path.extname(filename).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;

    const videoPath = path.join(courseDir, filename);
    const title = path.basename(filename, ext);
    const id = hashPath(videoPath);

    pending.push({ id, title, courseCode, videoPath });
  }
}

if (pending.length === 0) {
  console.log("No videos found in Incoming/. Nothing to process.");
  process.exit(0);
}

console.log(`Found ${pending.length} video(s) to process:\n`);
for (const v of pending) {
  console.log(`  - ${v.courseCode} / ${v.title}`);
}
console.log();

// ── Main processing ───────────────────────────────────────────────────────────

ensureDirectories();

if (!acquireLock()) {
  console.error("Another UniNotes instance is running (lock file exists). Exiting.");
  process.exit(1);
}

getDb();
resetStaleStatuses();

// Insert first, serially, so the "already in DB" skip is decided before any
// concurrent work starts.
const queued = pending.filter((entry) => {
  const localLecture: LocalLecture = {
    id: entry.id,
    title: entry.title,
    courseCode: entry.courseCode,
    videoPath: entry.videoPath,
  };
  if (insertLocalLecture(localLecture, retryErrors)) return true;
  console.log(`[SKIP]  ${entry.courseCode}/${entry.title} (already in DB — use --retry to re-run errors)`);
  return false;
});

console.log(
  `\nProcessing ${queued.length} video(s) — notes via ${providers.notes}, pretty via ${providers.pretty}, ` +
    `up to ${CONFIG.concurrency.lectures} at a time.\n`,
);

let done = 0;
let errors = 0;

try {
  const outcomes = await mapWithLimitSettled(queued, CONFIG.concurrency.lectures, async (entry) => {
    console.log(`[START] ${entry.courseCode}/${entry.title}`);
    const result = await processLecture(
      {
        id: entry.id,
        title: entry.title,
        courseCode: entry.courseCode,
        videoPath: entry.videoPath,
        panoptoUrl: `local://${entry.title}`,
        // Parts go to temp/ so a mid-run crash can't leave them looking like
        // new Incoming lectures on the next run.
        partsDir: CONFIG.paths.temp,
        onComplete: "move",
      },
      providers,
    );
    console.log(`[DONE]  ${entry.courseCode}/${entry.title}`);
    return result;
  });

  outcomes.forEach((outcome, i) => {
    if (outcome.ok) {
      done++;
      return;
    }
    errors++;
    const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    setError(queued[i].id, msg);
    console.error(`[ERROR] ${queued[i].courseCode}/${queued[i].title}: ${msg}`);
  });

  // Retry any pretty notes that failed here or on an earlier run.
  const backfill = await backfillPretty({
    provider: providers.pretty,
    onProgress: (label, phase, detail) => {
      if (phase === "done") console.log(`[PRETTY] ${label} (${detail})`);
      if (phase === "error") console.error(`[PRETTY] ${label} failed: ${detail}`);
    },
  });
  if (backfill.total > 0) {
    console.log(`\nPretty backfill: ${backfill.done} generated, ${backfill.errors} still failing`);
  }
} finally {
  await closeGeminiBrowser();
  releaseLock();
  closeDb();
}

console.log(`\nComplete: ${done} processed, ${errors} errors, ${queued.length} queued, ${pending.length} found`);

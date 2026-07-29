import { CONFIG } from "../config.js";
import { ensureDirectories } from "./utils/paths.js";
import { acquireLock, releaseLock } from "./utils/lock.js";
import { loadIgnoredTitles, isIgnoredTitle } from "./utils/ignoreList.js";
import { log } from "./utils/logger.js";
import { withRetry } from "./utils/retry.js";
import { getDb, closeDb } from "./db/schema.js";
import {
  insertLecture,
  getByStatus,
  updateStatus,
  setError,
  resetStaleStatuses,
  resetErroredPanoptoLectures,
} from "./db/tracker.js";
import { scrapePanopto, authPanopto, toNewLecture } from "./panopto/scraper.js";
import { downloadLecture } from "./panopto/downloader.js";
import { authGemini, closeGeminiBrowser } from "./gemini/browserPool.js";
import { processLecture } from "./pipeline/processLecture.js";
import { backfillPretty } from "./pipeline/prettyBackfill.js";
import { mapWithLimitSettled } from "./utils/limit.js";
import { resolveUploaderMode, resolvePrettyMode } from "./utils/uploaderMode.js";

// ── CLI argument handling ──────────────────────────────────────

const args = process.argv.slice(2);
const authMode = args.includes("--auth")
  ? args[args.indexOf("--auth") + 1]
  : null;
const retryErrors = args.includes("--retry");
const providers = {
  notes: resolveUploaderMode(args),
  pretty: resolvePrettyMode(args),
};

async function main(): Promise<void> {
  ensureDirectories();

  // Handle auth modes
  if (authMode === "panopto") {
    await authPanopto();
    return;
  }
  if (authMode === "gemini") {
    await authGemini();
    return;
  }

  // ── Normal pipeline run ──────────────────────────────────────

  // Acquire file lock to prevent concurrent runs
  if (!acquireLock()) {
    log.warn("Another instance is running (lock file exists). Exiting.");
    return;
  }

  try {
    log.info("=== UniNotes pipeline starting ===");

    // Step 0: Init DB, reset stale statuses
    getDb();
    resetStaleStatuses();
    if (retryErrors) {
      resetErroredPanoptoLectures();
    }

    // Step 1: Scrape Panopto for new lectures
    log.info("Step 1: Scraping Panopto...");
    const newLectures = await withRetry(() => scrapePanopto(), {
      label: "Panopto scrape",
      maxRetries: CONFIG.retry.maxRetries,
      delayMs: CONFIG.retry.delayMs,
    });

    const ignoredTitles = loadIgnoredTitles();
    const isIgnored = (title: string) => isIgnoredTitle(title, ignoredTitles);

    for (const lecture of newLectures) {
      if (isIgnored(lecture.title)) {
        log.info(`Ignored lecture (in ignore list): ${lecture.title}`);
        continue;
      }
      insertLecture(toNewLecture(lecture));
    }

    // Step 2: Download new lectures
    log.info("Step 2: Downloading new lectures...");
    const toDownload = getByStatus("new").filter((r) => !isIgnored(r.title));
    for (const lecture of toDownload) {
      try {
        updateStatus(lecture.id, "downloading");
        const tempPath = await withRetry(() => downloadLecture(lecture), {
          label: `Download ${lecture.title}`,
          maxRetries: CONFIG.retry.maxRetries,
          delayMs: CONFIG.retry.delayMs,
        });
        updateStatus(lecture.id, "downloaded", { temp_file: tempPath });
      } catch (err) {
        setError(lecture.id, err instanceof Error ? err.message : String(err));
      }
    }

    // Step 3-5: Process downloaded lectures through Gemini, concurrently.
    // Each lecture handles its own splitting, notes, prettifying and cleanup;
    // parts within a lecture are parallelised further inside the providers.
    const toProcess = getByStatus("downloaded").filter((r) => !isIgnored(r.title));
    log.info(
      `Step 3: Processing ${toProcess.length} lecture(s) — notes via ${providers.notes}, ` +
        `pretty via ${providers.pretty}, up to ${CONFIG.concurrency.lectures} at a time...`,
    );

    const outcomes = await mapWithLimitSettled(
      toProcess,
      CONFIG.concurrency.lectures,
      (lecture) =>
        processLecture(
          {
            id: lecture.id,
            title: lecture.title,
            courseCode: lecture.course_code,
            videoPath: lecture.temp_file!,
            panoptoUrl: lecture.panopto_url,
            // Deleted unless you've asked to keep it — see config.player.keep.
            // "cache", not "move": it goes to the video cache so the player can
            // use it this session, and is swept when UniNotes next starts.
            onComplete: CONFIG.player.keep ? "cache" : "delete",
          },
          providers,
        ),
    );

    // Record failures per lecture rather than letting one bad video abort the run.
    outcomes.forEach((outcome, i) => {
      if (!outcome.ok) {
        const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        log.error(`Failed: ${toProcess[i].title} — ${msg}`);
        setError(toProcess[i].id, msg);
      }
    });

    // Step 6: Retry any pretty notes that failed here or on an earlier run.
    // Prettifying is non-fatal, so without this sweep a failure would be
    // silently forgotten and the lecture left with raw notes only.
    const backfill = await backfillPretty({ provider: providers.pretty });
    if (backfill.total > 0) {
      log.info(`Pretty backfill: ${backfill.done} generated, ${backfill.errors} still failing`);
    }

    // Summary
    const complete = getByStatus("complete");
    const errors = getByStatus("error");
    log.info(
      `=== Pipeline complete: ${complete.length} done, ${errors.length} errors ===`,
    );
  } finally {
    await closeGeminiBrowser();
    releaseLock();
    closeDb();
  }
}

// ── Run ────────────────────────────────────────────────────────

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    log.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    await closeGeminiBrowser().catch(() => {});
    releaseLock();
    closeDb();
    process.exit(1);
  });

/**
 * Download the recording for lectures that already have notes, so the player in
 * the control panel has something to play.
 *
 * Usage:
 *   npx tsx scripts/fetch-video.ts --selection=<file.json>
 *
 * The pipeline deletes a Panopto video once its notes are written — the notes
 * are the artefact, and a semester of lectures is a lot of disk. This fetches one
 * back on demand, using the same authenticated browser flow the pipeline uses,
 * and puts it in the video cache under temp/, which UniNotes empties when it next
 * starts or stops. Fetching takes seconds; keeping costs a gigabyte, so nothing
 * here accumulates.
 *
 * Sequential on purpose: each download drives a real browser and moves a file
 * measured in hundreds of megabytes, so running several at once competes for
 * bandwidth and gains nothing.
 */

import fs from "node:fs";
import { CONFIG } from "../config.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { getDb, closeDb } from "../src/db/schema.js";
import type { LectureRow } from "../src/db/tracker.js";
import { downloadLecture } from "../src/panopto/downloader.js";
import { launchPanoptoBrowser } from "../src/panopto/scraper.js";
import { saveCaptions } from "../src/panopto/captions.js";
import { cacheVideo, videoCacheSize } from "../src/utils/videoCache.js";
import { listLectures, closeLibraryDb } from "../src/gui/library.js";

const cliArgs = process.argv.slice(2);

function readSelectionIds(): string[] {
  const arg = cliArgs.find((a) => a.startsWith("--selection="));
  if (!arg) {
    console.error("Missing --selection=<file.json>");
    process.exit(2);
  }
  const file = arg.slice("--selection=".length);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { ids?: string[] };
    return parsed.ids ?? [];
  } catch (err) {
    console.error(`Could not read selection file "${file}": ${(err as Error).message}`);
    process.exit(2);
  }
}

ensureDirectories();
const db = getDb();

interface Target {
  row: LectureRow;
  title: string;
  /** Already cached — this one only needs its captions. */
  hasVideo: boolean;
  hasCaptions: boolean;
}

/**
 * Selected lectures that can actually be fetched, with everything that ruled one
 * out reported rather than silently dropped — a run that says "nothing to do"
 * without saying why is indistinguishable from a broken one.
 */
function resolveTargets(ids: string[]): Target[] {
  const entries = listLectures();
  const targets: Target[] = [];

  for (const id of ids) {
    const entry = entries.find((e) => e.id === id);
    const label = entry?.title ?? id;

    if (!entry) {
      console.log(`- ${label}: not in the library any more, skipping.`);
      continue;
    }
    if (entry.hasVideo && entry.hasCaptions) {
      console.log(`- ${label}: already has both a video and captions, skipping.`);
      continue;
    }
    if (!entry.lectureDir) {
      console.log(`- ${label}: no lecture folder yet — process it first.`);
      continue;
    }
    // The player is notes synced to a recording, so fetching one for a lecture
    // with no notes downloads a gigabyte you can't do anything with. Enforced
    // here and not only in the panel: this script takes ids from a file.
    if (!entry.hasRaw && !entry.hasPretty) {
      console.log(`- ${label}: no notes yet — there'd be nothing to watch it against.`);
      continue;
    }
    if (entry.source !== "panopto") {
      console.log(`- ${label}: not from Panopto, so there is nowhere to fetch it from.`);
      continue;
    }

    const row = db.prepare("SELECT * FROM lectures WHERE id = ?").get(id) as LectureRow | undefined;
    if (!row) {
      console.log(`- ${label}: no database row, skipping.`);
      continue;
    }

    targets.push({
      row,
      title: entry.title,
      hasVideo: entry.hasVideo,
      hasCaptions: entry.hasCaptions,
    });
  }

  return targets;
}

async function main(): Promise<void> {
  const ids = readSelectionIds();
  if (ids.length === 0) {
    console.log("No lectures selected.");
    return;
  }

  const targets = resolveTargets(ids);
  if (targets.length === 0) {
    console.log("\nNothing left to fetch.");
    return;
  }

  if (!acquireLock()) {
    console.error("Another UniNotes run holds the lock. Try again when it finishes.");
    process.exit(1);
  }

  let done = 0;
  let failed = 0;
  let captioned = 0;

  try {
    // Captions first, and all of them through one browser context: each is a
    // single authenticated fetch, so opening a browser per lecture would cost
    // far more than the transcripts themselves.
    const wantCaptions = targets.filter((t) => !t.hasCaptions);
    if (wantCaptions.length > 0) {
      console.log(`\nFetching captions for ${wantCaptions.length} lecture(s)...`);
      const context = await launchPanoptoBrowser();
      try {
        for (const target of wantCaptions) {
          try {
            const saved = await saveCaptions(context, target.row.id);
            if (saved) captioned++;
            else console.log(`  ${target.title}: Panopto has no transcript for this one.`);
          } catch (err) {
            console.error(`  ${target.title}: captions failed — ${(err as Error).message}`);
          }
        }
      } finally {
        const browser = context.browser();
        await context.close().catch(() => {});
        await browser?.close().catch(() => {});
      }
    }

    for (const target of targets) {
      if (target.hasVideo) continue;
      console.log(`\nFetching video: ${target.title}`);
      try {
        const tempFile = await downloadLecture(target.row);
        const cached = cacheVideo(tempFile, target.row.id);
        if (!cached) throw new Error("Could not file the download in the video cache.");
        console.log(`  Cached: ${cached}`);
        done++;
      } catch (err) {
        failed++;
        // Non-fatal: one recording that has been taken down or whose viewer
        // layout changed must not stop the rest of the batch.
        console.error(`  Failed: ${(err as Error).message}`);
      }
    }
  } finally {
    releaseLock();
  }

  const cache = videoCacheSize();
  console.log(
    `\nFetched ${done} video${done === 1 ? "" : "s"}` +
      (failed > 0 ? `, ${failed} failed` : "") +
      `, ${captioned} transcript${captioned === 1 ? "" : "s"}. ` +
      `Cache now holds ${cache.files} video${cache.files === 1 ? "" : "s"} (${(cache.bytes / 1024 ** 3).toFixed(2)} GB).`,
  );
  console.log(
    `Cached in ${CONFIG.paths.videoCache}, videos and transcripts alike, and emptied when ` +
      `UniNotes next starts or stops — so nothing here builds up.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    closeLibraryDb();
    closeDb();
  });

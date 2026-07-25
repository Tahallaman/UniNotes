/**
 * Check Panopto for new lectures and record them — without downloading anything.
 *
 * Usage: npx tsx scripts/scan-panopto.ts
 *
 * The full pipeline scrapes and then immediately downloads and processes whatever
 * it found, which is the right default for an unattended run but the wrong one
 * when you just want to know what's appeared. Scanning separately lets the control
 * panel show you the new lectures and let you choose which to process, and it
 * costs a page load rather than several gigabytes.
 *
 * New lectures land at status 'new', exactly where the pipeline would have put
 * them, so a later `npm run dev` picks them up with no special handling.
 */

import { CONFIG } from "../config.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { withRetry } from "../src/utils/retry.js";
import { loadIgnoredTitles, isIgnoredTitle } from "../src/utils/ignoreList.js";
import { getDb, closeDb } from "../src/db/schema.js";
import { insertLecture, getByStatus } from "../src/db/tracker.js";
import { scrapePanopto, toNewLecture } from "../src/panopto/scraper.js";

ensureDirectories();
getDb();

let inserted = 0;
let ignored = 0;

try {
  console.log("Scanning Panopto for new lectures (no downloads)...\n");

  const scraped = await withRetry(() => scrapePanopto(), {
    label: "Panopto scrape",
    maxRetries: CONFIG.retry.maxRetries,
    delayMs: CONFIG.retry.delayMs,
  });

  const ignoredTitles = loadIgnoredTitles();

  for (const lecture of scraped) {
    if (isIgnoredTitle(lecture.title, ignoredTitles)) {
      console.log(`[IGNORE] ${lecture.title}`);
      ignored++;
      continue;
    }
    if (insertLecture(toNewLecture(lecture))) {
      console.log(`[NEW]    ${lecture.courseCode} · ${lecture.title}`);
      inserted++;
    }
  }

  const waiting = getByStatus("new").length;
  // scrapePanopto already drops anything the database has seen, so `scraped` is
  // the new-lecture count, not the number of rows on the Panopto page.
  console.log(
    `\nScan complete: ${scraped.length} new on Panopto, ${inserted} recorded, ${ignored} ignored.\n` +
      `${waiting} lecture(s) now waiting to be downloaded.`,
  );
} finally {
  closeDb();
}

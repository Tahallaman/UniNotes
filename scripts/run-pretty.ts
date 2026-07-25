/**
 * Generate lecture.pretty.md for every lecture.raw.md that doesn't have one yet.
 *
 * Usage: npx tsx scripts/run-pretty.ts [--pretty=api|browser] [--force]
 *
 * The discovery, concurrency and prettifying all live in
 * src/pipeline/prettyBackfill.ts, which the main pipeline runs automatically at
 * the end of every run — so this script is really just a manual trigger for the
 * same sweep.
 */

import { CONFIG } from "../config.js";
import { findPendingPretty, backfillPretty } from "../src/pipeline/prettyBackfill.js";
import { closeGeminiBrowser } from "../src/gemini/browserPool.js";
import { resolvePrettyMode } from "../src/utils/uploaderMode.js";

const cliArgs = process.argv.slice(2);
const provider = resolvePrettyMode(cliArgs);
/** Regenerate even where lecture.pretty.md already exists. */
const force = cliArgs.includes("--force");

const pending = findPendingPretty(force);

if (pending.length === 0) {
  console.log("All lectures already have pretty notes. Nothing to do. (Use --force to regenerate.)");
  process.exit(0);
}

console.log(`Found ${pending.length} lecture(s) needing pretty notes:\n`);
for (const entry of pending) {
  console.log(`  - ${entry.label}`);
}
console.log(`\nProvider: ${provider} · up to ${CONFIG.concurrency.lectures} at a time\n`);

try {
  const result = await backfillPretty({
    provider,
    entries: pending,
    onProgress: (label, phase, detail) => {
      if (phase === "start") console.log(`[START] ${label}`);
      if (phase === "done") console.log(`[DONE]  ${label} (${detail})`);
      if (phase === "error") console.error(`[ERROR] ${label}: ${detail}`);
    },
  });

  console.log(`\nComplete: ${result.done} prettified, ${result.errors} errors, ${result.total} total`);
} finally {
  await closeGeminiBrowser();
}

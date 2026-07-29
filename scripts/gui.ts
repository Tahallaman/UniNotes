/**
 * Launch the UniNotes control panel.
 *
 * Usage: npx tsx scripts/gui.ts [--port=4571] [--no-open]
 */

import { spawn } from "node:child_process";
import { startServer, stopServer } from "../src/gui/server.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { getDb, closeDb } from "../src/db/schema.js";
import { clearVideoCache, type CacheSweep } from "../src/utils/videoCache.js";

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="));
const port = portArg ? parseInt(portArg.slice("--port=".length), 10) : 4571;
const shouldOpen = !args.includes("--no-open");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port "${portArg}".`);
  process.exit(2);
}

ensureDirectories();

function reportSweep(when: string, swept: CacheSweep): void {
  if (swept.files === 0) return;
  const gb = (swept.bytes / 1024 ** 3).toFixed(2);
  console.log(`  Cleared ${swept.files} cached video${swept.files === 1 ? "" : "s"} (${gb} GB) ${when}.`);
}

// Swept at both ends, not just on exit: a crash or a kill -9 never runs the
// shutdown path, and the cache is exactly the thing that must not survive one.
reportSweep("from the last session", clearVideoCache());

// Create/migrate the database once here, up front. Everything the GUI does
// afterwards reads through a read-only connection, which cannot create the file
// and would otherwise fail on a fresh checkout until the first pipeline run.
try {
  getDb();
} finally {
  closeDb();
}

let server;
try {
  server = await startServer(port);
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use — the control panel may already be running at http://localhost:${port}\n` +
        `Use --port=<n> to run a second one.`,
    );
    process.exit(1);
  }
  throw err;
}

const url = `http://localhost:${port}`;
console.log(`\n  UniNotes control panel → ${url}\n  Press Ctrl-C to stop.\n`);

if (shouldOpen) {
  // `start` is a cmd builtin, so it needs a shell. The empty "" is the window
  // title argument start expects when the first quoted token would be read as one.
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    stopServer(server)
      .finally(() => reportSweep("on shutdown", clearVideoCache()))
      .finally(() => process.exit(0));
  });
}

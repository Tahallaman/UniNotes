/**
 * Launch the UniNotes control panel.
 *
 * Usage: npx tsx scripts/gui.ts [--port=4571] [--no-open]
 */

import { spawn } from "node:child_process";
import { startServer, stopServer } from "../src/gui/server.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { getDb, closeDb } from "../src/db/schema.js";

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="));
const port = portArg ? parseInt(portArg.slice("--port=".length), 10) : 4571;
const shouldOpen = !args.includes("--no-open");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port "${portArg}".`);
  process.exit(2);
}

ensureDirectories();

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
    stopServer(server).finally(() => process.exit(0));
  });
}

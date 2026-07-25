/**
 * The single-instance lock, shared by every entry point that runs the pipeline.
 *
 * Was copied verbatim into src/main.ts and scripts/process-local.ts; a third copy
 * for scripts/process-selected.ts made extracting it the obvious move. The stale
 * detection in particular is not something worth maintaining in triplicate.
 */

import fs from "node:fs";
import { CONFIG } from "../../config.js";
import { log } from "./logger.js";

/**
 * Take the lock, or report that another run holds it.
 *
 * A lock file whose PID is no longer running is removed and retried once: the
 * common cause is a run killed with Ctrl-C or a machine restart mid-pipeline, and
 * requiring manual cleanup after that would be a daily annoyance.
 */
export function acquireLock(): boolean {
  try {
    // O_EXCL makes create-if-absent atomic, so two processes starting together
    // can't both believe they got the lock.
    const fd = fs.openSync(
      CONFIG.paths.lockFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    fs.writeSync(fd, `${process.pid}`);
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const pid = parseInt(fs.readFileSync(CONFIG.paths.lockFile, "utf-8"), 10);
      try {
        process.kill(pid, 0); // existence test, sends nothing
        return false;
      } catch {
        log.warn(`Removing stale lock (PID ${pid} no longer running)`);
        fs.unlinkSync(CONFIG.paths.lockFile);
        return acquireLock();
      }
    } catch {
      return false;
    }
  }
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(CONFIG.paths.lockFile);
  } catch {
    // Already removed.
  }
}

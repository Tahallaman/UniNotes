/**
 * The few database writes the GUI performs directly.
 *
 * Deliberately separate from library.ts, which is read-only on purpose. These are
 * small, instantaneous statements — resetting a status so a lecture is picked up
 * again — that would be absurd to spawn a whole child process for.
 *
 * Each opens its own connection and closes it immediately rather than holding one
 * open. A pipeline run is a separate process holding the write lock; a long-lived
 * writer here would sooner or later block it, and there is nothing to gain from
 * keeping a connection alive between button presses.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { CONFIG } from "../../config.js";

function withWriteDb<T>(fn: (db: Database.Database) => T): T {
  if (!fs.existsSync(CONFIG.paths.db)) {
    throw new Error("No database yet — run the pipeline once first.");
  }
  const db = new Database(CONFIG.paths.db);
  db.pragma("journal_mode = WAL");
  // A run in progress can hold the write lock briefly. Wait rather than throwing
  // an opaque SQLITE_BUSY at the user for something that resolves in milliseconds.
  db.pragma("busy_timeout = 4000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Put lectures back into the pipeline.
 *
 * Where they land depends on whether the video is still on disk: with it, they
 * resume at 'downloaded' and skip a re-download; without, they go back to 'new'.
 * Local lectures have no download URL, so they can only be reset when their file
 * is still present.
 */
export function resetForRetry(ids: string[]): { reset: number; skipped: string[] } {
  if (ids.length === 0) return { reset: 0, skipped: [] };

  return withWriteDb((db) => {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, title, source, temp_file FROM lectures WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string; title: string; source: string; temp_file: string | null }>;

    const toDownloaded = db.prepare(
      `UPDATE lectures SET status = 'downloaded', error_message = NULL, updated_at = datetime('now') WHERE id = ?`,
    );
    const toNew = db.prepare(
      `UPDATE lectures SET status = 'new', error_message = NULL, updated_at = datetime('now') WHERE id = ?`,
    );

    let reset = 0;
    const skipped: string[] = [];

    const run = db.transaction(() => {
      for (const row of rows) {
        const hasVideo = row.temp_file !== null && fs.existsSync(row.temp_file);
        if (hasVideo) {
          toDownloaded.run(row.id);
          reset++;
        } else if (row.source === "local") {
          skipped.push(`${row.title} (source video is gone — put it back in Incoming/)`);
        } else {
          toNew.run(row.id);
          reset++;
        }
      }
    });
    run();

    return { reset, skipped };
  });
}

/**
 * Forget a lecture entirely so it can be re-scraped and reprocessed from scratch.
 * Note files on disk are left alone — this removes the tracking row, not your notes.
 */
export function forgetLectures(ids: string[]): number {
  if (ids.length === 0) return 0;
  return withWriteDb((db) => {
    const placeholders = ids.map(() => "?").join(",");
    return db.prepare(`DELETE FROM lectures WHERE id IN (${placeholders})`).run(...ids).changes;
  });
}

/**
 * Resolve a lecture directory that the caller supplied, refusing anything outside
 * Lectures/.
 *
 * The path arrives in an HTTP request and is handed to a shell-adjacent operation
 * (opening a file browser). Without this it would be a way to open, or later read,
 * arbitrary directories on the machine.
 */
export function assertInsideLectures(dir: string): string {
  const resolved = path.resolve(dir);
  const root = path.resolve(CONFIG.paths.lectures);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to act on a path outside the Lectures folder.");
  }
  return resolved;
}

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
import { addLateColumns } from "../db/schema.js";
import { effectiveConfig } from "./effective.js";

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
    // These connections never pass through getDb(), so nothing else here would
    // teach an older database about columns the panel writes to.
    addLateColumns(db);
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
 * Tick or untick "watched" for lectures.
 *
 * Deliberately leaves updated_at alone. It is a note about you, not about the
 * lecture's progress through the pipeline, and the library is sorted by
 * updated_at — bumping it would throw a lecture to the top of the list every time
 * you ticked a box.
 *
 * Unticking also forgets where you got to. Without that, unticking a lecture you
 * had watched to the end would put a "97% watched" dash straight back in the box
 * you just cleared, and reopening it would resume ninety seconds from the end —
 * so the untick would look like it hadn't worked and then behave as if it
 * hadn't. Clearing it makes the empty box mean what it says: start again.
 */
export function setWatched(ids: string[], watched: boolean): number {
  if (ids.length === 0) return 0;
  return withWriteDb((db) => {
    const placeholders = ids.map(() => "?").join(",");
    const set = watched ? "watched = 1" : "watched = 0, resume_at = NULL";
    return db
      .prepare(`UPDATE lectures SET ${set} WHERE id IN (${placeholders})`)
      .run(...ids).changes;
  });
}

/**
 * Record how far into a recording you have got.
 *
 * Written from the player every few seconds and whenever it stops, so the
 * Library can say "in progress" and the next opening can pick up where you left
 * off. Like setWatched, it leaves updated_at alone: watching a lecture is not a
 * change to the lecture, and the library is sorted by that column.
 *
 * The threshold tick lives here rather than in the browser so that the rule is
 * the settings' rule wherever progress arrives from, and so a client that stops
 * reporting mid-lecture can't leave a lecture stuck one percent short forever.
 * Never unticks: a box you ticked by hand is a statement, and rewatching the
 * first ten minutes of a lecture you have seen is not a retraction of it.
 */
export function setProgress(
  id: string,
  seconds: number,
  duration: number,
): { watched: boolean; fraction: number } {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Progress must be a position in seconds.");
  const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const at = length > 0 ? Math.min(seconds, length) : seconds;
  const fraction = length > 0 ? at / length : 0;

  const percent = Number(effectiveConfig().player.watchedAt ?? 90);
  const threshold = Math.min(100, Math.max(50, Number.isFinite(percent) ? percent : 90)) / 100;
  const reached = length > 0 && fraction >= threshold;

  return withWriteDb((db) => {
    db.prepare(
      `UPDATE lectures SET resume_at = ?, video_seconds = ?${reached ? ", watched = 1" : ""} WHERE id = ?`,
    ).run(at, length > 0 ? length : null, id);
    const row = db.prepare(`SELECT watched FROM lectures WHERE id = ?`).get(id) as
      | { watched: number }
      | undefined;
    return { watched: row?.watched === 1, fraction };
  });
}

/**
 * Correct a lecture's date by hand, or clear the correction.
 *
 * The one manual input in an otherwise derived chain: everything about which
 * term and week a lecture belongs to follows from its date, so this is the only
 * lever needed when Panopto's record or a title's date is wrong. Passing null
 * removes the override and lets resolution fall back to what it can work out.
 */
export function setLectureDate(id: string, date: string | null): void {
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`"${date}" isn't a date — use YYYY-MM-DD.`);
  }
  withWriteDb((db) => {
    const changed = db
      .prepare(`UPDATE lectures SET date_override = ? WHERE id = ?`)
      .run(date, id).changes;
    if (changed === 0) throw new Error("That lecture isn't tracked in the database.");
  });
}

/**
 * Record how far a downloaded recording runs ahead of its transcript.
 *
 * Set from the player, where the mistake is visible and the correction can be
 * heard immediately. Bounded at twenty minutes because the failure this fixes is
 * a trimmed front — a number past that is a typo, and a typo here would put every
 * timestamp in the lecture somewhere else.
 *
 * Like the other player writes, it leaves updated_at alone: aligning a
 * transcript is not a change to the lecture, and the library is sorted by that
 * column.
 */
export function setCaptionOffset(id: string, seconds: number): number {
  if (!Number.isFinite(seconds)) throw new Error("An offset has to be a number of seconds.");
  const at = Math.max(-1200, Math.min(1200, Math.round(seconds * 1000) / 1000));
  withWriteDb((db) => {
    const changed = db
      .prepare(`UPDATE lectures SET caption_offset = ? WHERE id = ?`)
      .run(at, id).changes;
    if (changed === 0) throw new Error("That lecture isn't tracked in the database.");
  });
  return at;
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

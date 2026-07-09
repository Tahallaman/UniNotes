import fs from "node:fs";
import { getDb } from "./schema.js";
import { log } from "../utils/logger.js";

export type LectureStatus =
  | "new"
  | "downloading"
  | "downloaded"
  | "processing"
  | "processed"
  | "complete"
  | "error";

export interface LectureRow {
  id: string;
  title: string;
  course_code: string;
  panopto_url: string;
  download_url: string | null;
  status: LectureStatus;
  source: "panopto" | "local";
  temp_file: string | null;
  notes_file: string | null;
  gemini_chat_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewLecture {
  id: string;
  title: string;
  courseCode: string;
  panoptoUrl: string;
  downloadUrl: string;
}

const NOW = "datetime('now')";

export function insertLecture(lecture: NewLecture): boolean {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO lectures (id, title, course_code, panopto_url, download_url)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    lecture.id,
    lecture.title,
    lecture.courseCode,
    lecture.panoptoUrl,
    lecture.downloadUrl,
  );
  if (result.changes > 0) {
    log.info(`Inserted new lecture: ${lecture.title} [${lecture.courseCode}]`);
    return true;
  }
  return false;
}

export function getByStatus(status: LectureStatus): LectureRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM lectures WHERE status = ?").all(status) as LectureRow[];
}

export function updateStatus(
  id: string,
  status: LectureStatus,
  extra?: Partial<Pick<LectureRow, "temp_file" | "notes_file" | "gemini_chat_url" | "error_message">>,
): void {
  const db = getDb();
  const sets = [`status = ?`, `updated_at = ${NOW}`];
  const params: unknown[] = [status];

  if (extra?.temp_file !== undefined) {
    sets.push("temp_file = ?");
    params.push(extra.temp_file);
  }
  if (extra?.notes_file !== undefined) {
    sets.push("notes_file = ?");
    params.push(extra.notes_file);
  }
  if (extra?.gemini_chat_url !== undefined) {
    sets.push("gemini_chat_url = ?");
    params.push(extra.gemini_chat_url);
  }
  if (extra?.error_message !== undefined) {
    sets.push("error_message = ?");
    params.push(extra.error_message);
  }

  params.push(id);
  db.prepare(`UPDATE lectures SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function setError(id: string, message: string): void {
  updateStatus(id, "error", { error_message: message });
  log.error(`Lecture ${id} marked as error: ${message}`);
}

/**
 * Reset stale in-progress statuses back so they get retried.
 * downloading → new, processing → downloaded
 */
export function resetStaleStatuses(): void {
  const db = getDb();
  const r1 = db
    .prepare(`UPDATE lectures SET status = 'new', updated_at = ${NOW} WHERE status = 'downloading'`)
    .run();
  const r2 = db
    .prepare(`UPDATE lectures SET status = 'downloaded', updated_at = ${NOW} WHERE status = 'processing'`)
    .run();
  const r3 = db
    .prepare(`UPDATE lectures SET status = 'downloaded', updated_at = ${NOW} WHERE status = 'processed'`)
    .run();

  const total = r1.changes + r2.changes + r3.changes;
  if (total > 0) {
    log.info(`Reset ${total} stale lecture(s) to retry`);
  }
}

export interface LocalLecture {
  id: string;       // MD5 hash of absolute video path
  title: string;
  courseCode: string;
  videoPath: string; // absolute path to the Incoming video file
}

export function insertLocalLecture(l: LocalLecture, retryErrors = false): boolean {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO lectures (id, title, course_code, panopto_url, status, source, temp_file)
    VALUES (?, ?, ?, ?, 'downloaded', 'local', ?)
  `);
  const result = insert.run(l.id, l.title, l.courseCode, `local://${l.title}`, l.videoPath);
  if (result.changes > 0) {
    log.info(`Inserted local lecture: ${l.title} [${l.courseCode}]`);
    return true;
  }

  if (retryErrors) {
    const row = db.prepare("SELECT status FROM lectures WHERE id = ?").get(l.id) as { status: string } | undefined;
    // Also retry "downloaded" — this occurs when a previous run was killed mid-processing:
    // processing → (resetStaleStatuses on next startup) → downloaded → stuck here.
    if (row?.status === "error" || row?.status === "downloaded") {
      db.prepare(`
        UPDATE lectures SET status = 'downloaded', temp_file = ?, error_message = NULL,
        updated_at = datetime('now') WHERE id = ?
      `).run(l.videoPath, l.id);
      log.info(`Resetting lecture for retry (was '${row?.status}'): ${l.title} [${l.courseCode}]`);
      return true;
    }
  }

  return false;
}

/**
 * Reset errored Panopto lectures so they get retried in the next pipeline run.
 * - Has temp_file on disk → reset to 'downloaded' (skip re-download)
 * - No temp_file (or file missing) → reset to 'new' (will re-download)
 * Local lectures are excluded — retry those via `npm run local -- --retry`.
 */
export function resetErroredPanoptoLectures(): void {
  const db = getDb();
  const errored = db
    .prepare("SELECT * FROM lectures WHERE status = 'error' AND source = 'panopto'")
    .all() as LectureRow[];

  let toDownload = 0;
  let toProcess = 0;

  for (const row of errored) {
    const hasFile = row.temp_file !== null && fs.existsSync(row.temp_file);
    if (hasFile) {
      db.prepare(
        `UPDATE lectures SET status = 'downloaded', error_message = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(row.id);
      toProcess++;
    } else {
      db.prepare(
        `UPDATE lectures SET status = 'new', error_message = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(row.id);
      toDownload++;
    }
  }

  if (toDownload + toProcess > 0) {
    log.info(`Retry: reset ${toDownload} lecture(s) to 'new', ${toProcess} to 'downloaded'`);
  }
}

export function lectureExists(id: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM lectures WHERE id = ?").get(id);
  return row !== undefined;
}

export function getAllLectures(): LectureRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM lectures ORDER BY created_at DESC").all() as LectureRow[];
}

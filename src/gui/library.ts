/**
 * The lecture library the GUI displays: the database and the disk, merged.
 *
 * Neither source is sufficient alone. The database knows about lectures that
 * haven't produced notes yet — scraped, downloading, errored — which have nothing
 * on disk to find. The disk holds lectures whose rows predate parts of the current
 * tracking, or were written by an older layout; a library that quietly omitted
 * those would be worse than no library, because "it's not in the list" would stop
 * meaning "it doesn't exist".
 *
 * All reads use a **read-only** SQLite connection. A pipeline run is a separate
 * process holding the write lock, and the GUI polls every few seconds — opening
 * read-write here would eventually collide with a run for no benefit, since the
 * GUI never writes through this module.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { CONFIG } from "../../config.js";
import type { LectureRow, LectureStatus } from "../db/tracker.js";

/** "on-disk" is not a DB status — it marks a lecture folder with no row. */
export type LibraryStatus = LectureStatus | "on-disk";

export interface LibraryEntry {
  /** Stable identifier for the UI. The DB id when there is one, else the folder. */
  key: string;
  id: string | null;
  title: string;
  courseCode: string;
  status: LibraryStatus;
  source: "panopto" | "local" | "disk";
  panoptoUrl: string | null;
  geminiChatUrl: string | null;
  errorMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Absolute path to Lectures/<course>/<title>/, when it exists. */
  lectureDir: string | null;
  hasRaw: boolean;
  hasPretty: boolean;
  hasVideo: boolean;
  rawBytes: number | null;
  prettyBytes: number | null;
  /** Resume progress, if a checkpoint is sitting in temp/. */
  checkpoint: { done: number; total: number } | null;
}

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".mov", ".avi", ".webm"];

// ── Database access ───────────────────────────────────────────────────────────

let readDb: Database.Database | null = null;

function getReadDb(): Database.Database | null {
  if (readDb) return readDb;
  if (!fs.existsSync(CONFIG.paths.db)) return null;
  try {
    readDb = new Database(CONFIG.paths.db, { readonly: true, fileMustExist: true });
    // Matches the writer. Without it a WAL database is unreadable read-only.
    readDb.pragma("journal_mode = WAL");
    return readDb;
  } catch {
    return null;
  }
}

export function closeLibraryDb(): void {
  readDb?.close();
  readDb = null;
}

function allRows(): LectureRow[] {
  const db = getReadDb();
  if (!db) return [];
  try {
    return db.prepare("SELECT * FROM lectures ORDER BY created_at DESC").all() as LectureRow[];
  } catch {
    // Table not created yet — the pipeline has never run.
    return [];
  }
}

// ── Disk scanning ─────────────────────────────────────────────────────────────

interface DiskLecture {
  lectureDir: string;
  courseCode: string;
  title: string;
  hasRaw: boolean;
  hasPretty: boolean;
  hasVideo: boolean;
  rawBytes: number | null;
  prettyBytes: number | null;
  mtime: string;
}

function safeIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sizeOf(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function scanDisk(): Map<string, DiskLecture> {
  const found = new Map<string, DiskLecture>();
  if (!fs.existsSync(CONFIG.paths.lectures)) return found;

  for (const course of fs.readdirSync(CONFIG.paths.lectures)) {
    const courseDir = path.join(CONFIG.paths.lectures, course);
    if (!safeIsDirectory(courseDir)) continue;

    for (const lecture of fs.readdirSync(courseDir)) {
      const lectureDir = path.join(courseDir, lecture);
      if (!safeIsDirectory(lectureDir)) continue;

      const rawPath = path.join(lectureDir, "lecture.raw.md");
      const prettyPath = path.join(lectureDir, "lecture.pretty.md");
      const hasRaw = fs.existsSync(rawPath);
      const hasPretty = fs.existsSync(prettyPath);
      const hasVideo = VIDEO_EXTENSIONS.some((ext) =>
        fs.existsSync(path.join(lectureDir, `lecture${ext}`)),
      );

      // A folder with none of the three is an empty leftover, not a lecture.
      if (!hasRaw && !hasPretty && !hasVideo) continue;

      let mtime = "";
      try {
        mtime = fs.statSync(hasRaw ? rawPath : lectureDir).mtime.toISOString();
      } catch {
        // Keep the entry; an unreadable mtime only affects sort order.
      }

      found.set(normalizeDir(lectureDir), {
        lectureDir,
        courseCode: course,
        title: lecture,
        hasRaw,
        hasPretty,
        hasVideo,
        rawBytes: hasRaw ? sizeOf(rawPath) : null,
        prettyBytes: hasPretty ? sizeOf(prettyPath) : null,
        mtime,
      });
    }
  }

  return found;
}

/** Case- and separator-insensitive, because notes_file and a directory walk
 *  produce the same folder spelled two different ways on Windows. */
function normalizeDir(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

// ── Checkpoints ───────────────────────────────────────────────────────────────

interface CheckpointInfo {
  done: number;
  total: number;
}

/** Resume state for every lecture that has a checkpoint directory in temp/. */
function scanCheckpoints(): Map<string, CheckpointInfo> {
  const result = new Map<string, CheckpointInfo>();
  const root = path.join(CONFIG.paths.temp, "checkpoints");
  if (!fs.existsSync(root)) return result;

  for (const dirName of fs.readdirSync(root)) {
    const dir = path.join(root, dirName);
    if (!safeIsDirectory(dir)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")) as {
        totalParts?: number;
      };
      const done = fs.readdirSync(dir).filter((f) => /^part-\d+\.md$/.test(f)).length;
      result.set(dirName, { done, total: manifest.totalParts ?? done });
    } catch {
      // Half-written or hand-deleted checkpoint — nothing useful to report.
    }
  }

  return result;
}

/** Mirrors safeId() in src/pipeline/checkpoint.ts, which names the directory. */
function checkpointKey(lectureId: string): string {
  return lectureId.replace(/[^\w.-]+/g, "_").slice(0, 100) || "lecture";
}

// ── Assembly ──────────────────────────────────────────────────────────────────

export function listLectures(): LibraryEntry[] {
  const rows = allRows();
  const disk = scanDisk();
  const checkpoints = scanCheckpoints();
  const entries: LibraryEntry[] = [];
  const claimed = new Set<string>();

  for (const row of rows) {
    // notes_file is the lecture directory once a lecture completes. Before that
    // it's null, so fall back to matching a folder by course + title — that's how
    // a lecture that errored *after* writing notes still shows its files.
    const dirFromDb = row.notes_file ? normalizeDir(row.notes_file) : null;
    const guessed = normalizeDir(
      path.join(CONFIG.paths.lectures, row.course_code, sanitizeFilename(row.title)),
    );
    const matchKey = dirFromDb && disk.has(dirFromDb) ? dirFromDb : disk.has(guessed) ? guessed : null;
    const onDisk = matchKey ? disk.get(matchKey)! : null;
    if (matchKey) claimed.add(matchKey);

    const cp = checkpoints.get(checkpointKey(row.id)) ?? null;

    entries.push({
      key: row.id,
      id: row.id,
      title: row.title,
      courseCode: row.course_code,
      status: row.status,
      source: row.source ?? "panopto",
      panoptoUrl: row.panopto_url?.startsWith("local://") ? null : row.panopto_url,
      geminiChatUrl: row.gemini_chat_url,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lectureDir: onDisk?.lectureDir ?? null,
      hasRaw: onDisk?.hasRaw ?? false,
      hasPretty: onDisk?.hasPretty ?? false,
      hasVideo: onDisk?.hasVideo ?? false,
      rawBytes: onDisk?.rawBytes ?? null,
      prettyBytes: onDisk?.prettyBytes ?? null,
      checkpoint: cp,
    });
  }

  // Whatever the database didn't account for is still real and still actionable.
  for (const [key, d] of disk) {
    if (claimed.has(key)) continue;
    entries.push({
      key: `disk:${d.lectureDir}`,
      id: null,
      title: d.title,
      courseCode: d.courseCode,
      status: "on-disk",
      source: "disk",
      panoptoUrl: null,
      geminiChatUrl: null,
      errorMessage: null,
      createdAt: d.mtime || null,
      updatedAt: d.mtime || null,
      lectureDir: d.lectureDir,
      hasRaw: d.hasRaw,
      hasPretty: d.hasPretty,
      hasVideo: d.hasVideo,
      rawBytes: d.rawBytes,
      prettyBytes: d.prettyBytes,
      checkpoint: null,
    });
  }

  entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return entries;
}

/** Same rule writer.ts uses to turn a lecture title into a folder name. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * Lecture counts per status, for the "what's waiting" list.
 * Straight from SQL rather than from listLectures() — the status panel refreshes
 * every few seconds and has no use for a full filesystem walk.
 */
export function lectureCounts(): Record<string, number> {
  const db = getReadDb();
  if (!db) return {};
  try {
    const rows = db
      .prepare("SELECT status, COUNT(*) AS n FROM lectures GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  } catch {
    return {};
  }
}

export interface LibrarySummary {
  total: number;
  byStatus: Record<string, number>;
  courses: string[];
  missingPretty: number;
}

export function summarize(entries: LibraryEntry[]): LibrarySummary {
  const byStatus: Record<string, number> = {};
  const courses = new Set<string>();
  let missingPretty = 0;

  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    courses.add(e.courseCode);
    if (e.hasRaw && !e.hasPretty) missingPretty++;
  }

  return {
    total: entries.length,
    byStatus,
    courses: [...courses].sort(),
    missingPretty,
  };
}

/**
 * Read one of a lecture's note files.
 *
 * The path is rebuilt from the library rather than taken from the request, so a
 * crafted `../..` can't walk the filesystem through a server that is otherwise
 * happy to read any file it's asked for.
 */
export function readNotes(key: string, which: "raw" | "pretty"): { path: string; content: string } | null {
  const entry = listLectures().find((e) => e.key === key);
  if (!entry?.lectureDir) return null;

  const filePath = path.join(entry.lectureDir, which === "raw" ? "lecture.raw.md" : "lecture.pretty.md");
  try {
    return { path: filePath, content: fs.readFileSync(filePath, "utf-8") };
  } catch {
    return null;
  }
}

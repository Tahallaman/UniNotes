import Database from "better-sqlite3";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(CONFIG.paths.db);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lectures (
      id              TEXT PRIMARY KEY,          -- Panopto GUID or local hash
      title           TEXT NOT NULL,
      course_code     TEXT NOT NULL,
      panopto_url     TEXT NOT NULL,
      download_url    TEXT,
      status          TEXT NOT NULL DEFAULT 'new'
                        CHECK(status IN (
                          'new','downloading','downloaded',
                          'processing','processed','complete','error','blank'
                        )),
      temp_file       TEXT,
      notes_file      TEXT,
      gemini_chat_url TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      -- Set by hand from the Library, never by the pipeline. 0 = not watched.
      watched         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_lectures_status ON lectures(status);
    CREATE INDEX IF NOT EXISTS idx_lectures_course ON lectures(course_code);
  `);

  // Add source column if not present (SQLite doesn't support ADD COLUMN IF NOT EXISTS)
  const cols = db.pragma("table_info(lectures)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "source")) {
    db.exec(`ALTER TABLE lectures ADD COLUMN source TEXT NOT NULL DEFAULT 'panopto'`);
  }

  widenStatusCheck(db);

  // After the rebuild above, not before: it recreates the table from a fixed
  // column list that predates these, so a column added first would be dropped.
  addLateColumns(db);

  log.info("Database initialized");
}

/**
 * Columns added after the table's original shape was set.
 *
 * Exported because the pipeline is not the only writer. The control panel writes
 * through short-lived connections of its own — deliberately, so it never holds
 * the write lock against a run — and those never pass through getDb(). Without
 * this, ticking Watched or recording where you got to in a video would fail
 * against a database that had not happened to run the pipeline since the column
 * was invented.
 *
 * Every branch is a no-op once applied, so calling it per connection costs one
 * pragma.
 */
export function addLateColumns(db: Database.Database): void {
  const cols = db.pragma("table_info(lectures)") as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);

  if (!has("watched")) {
    db.exec(`ALTER TABLE lectures ADD COLUMN watched INTEGER NOT NULL DEFAULT 0`);
  }
  // The recording's own date, straight from Panopto's Date column.
  if (!has("recorded_at")) {
    db.exec(`ALTER TABLE lectures ADD COLUMN recorded_at TEXT`);
  }
  // A date you corrected by hand. Only ever set from the Library — everything
  // else about a lecture's week is derived, so this is the sole escape hatch.
  if (!has("date_override")) {
    db.exec(`ALTER TABLE lectures ADD COLUMN date_override TEXT`);
  }
  // How far into the recording you got, in seconds, and how long the recording
  // is. The length is stored alongside because "43% through" has to be
  // answerable from the Library, where no video is open to measure.
  if (!has("resume_at")) {
    db.exec(`ALTER TABLE lectures ADD COLUMN resume_at REAL`);
  }
  if (!has("video_seconds")) {
    db.exec(`ALTER TABLE lectures ADD COLUMN video_seconds REAL`);
  }
}

/**
 * Teach an existing database about statuses added after it was created.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table entirely alone, including
 * its CHECK constraint — so a database created before 'blank' existed would
 * accept the new code happily right up until the first UPDATE, then fail the
 * constraint. SQLite cannot alter a CHECK, so the only route is a table rebuild.
 *
 * Guarded by reading the stored DDL, so this runs once and is a no-op forever
 * after. Wrapped in a transaction: a rebuild interrupted halfway would otherwise
 * leave no lectures table at all.
 */
function widenStatusCheck(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lectures'")
    .get() as { sql?: string } | undefined;
  const ddl = row?.sql ?? "";
  if (ddl.length === 0 || ddl.includes("'blank'")) return;

  log.info("Migrating lectures table to allow the 'blank' status...");
  db.exec("PRAGMA foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE lectures_migrated (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        course_code     TEXT NOT NULL,
        panopto_url     TEXT NOT NULL,
        download_url    TEXT,
        status          TEXT NOT NULL DEFAULT 'new'
                          CHECK(status IN (
                            'new','downloading','downloaded',
                            'processing','processed','complete','error','blank'
                          )),
        temp_file       TEXT,
        notes_file      TEXT,
        gemini_chat_url TEXT,
        error_message   TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        source          TEXT NOT NULL DEFAULT 'panopto'
      );

      INSERT INTO lectures_migrated
        SELECT id, title, course_code, panopto_url, download_url, status,
               temp_file, notes_file, gemini_chat_url, error_message,
               created_at, updated_at, source
        FROM lectures;

      DROP TABLE lectures;
      ALTER TABLE lectures_migrated RENAME TO lectures;

      CREATE INDEX IF NOT EXISTS idx_lectures_status ON lectures(status);
      CREATE INDEX IF NOT EXISTS idx_lectures_course ON lectures(course_code);
    `);
  })();
  db.exec("PRAGMA foreign_keys = ON");
  log.info("Migration complete.");
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

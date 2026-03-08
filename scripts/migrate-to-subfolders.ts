/**
 * One-time migration: move existing flat lecture .md files into per-lecture
 * subfolders as lecture.raw.md.
 *
 * Usage: npx tsx scripts/migrate-to-subfolders.ts
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = path.resolve(import.meta.dirname!, "..");
const LECTURES_DIR = path.join(ROOT, "Lectures");
const DB_PATH = path.join(ROOT, "uninotes.db");

let migrated = 0;
let skipped = 0;

// Walk each course directory
for (const course of fs.readdirSync(LECTURES_DIR)) {
  const courseDir = path.join(LECTURES_DIR, course);
  if (!fs.statSync(courseDir).isDirectory()) continue;

  for (const entry of fs.readdirSync(courseDir)) {
    const fullPath = path.join(courseDir, entry);
    const stat = fs.statSync(fullPath);

    // Only process .md files (not directories)
    if (!stat.isFile() || !entry.endsWith(".md")) {
      skipped++;
      continue;
    }

    const baseName = entry.replace(/\.md$/, "");
    const lectureDir = path.join(courseDir, baseName);
    const newPath = path.join(lectureDir, "lecture.raw.md");

    // Don't overwrite if already migrated
    if (fs.existsSync(newPath)) {
      console.log(`SKIP (already exists): ${newPath}`);
      skipped++;
      continue;
    }

    fs.mkdirSync(lectureDir, { recursive: true });
    fs.renameSync(fullPath, newPath);
    console.log(`MIGRATED: ${entry} → ${baseName}/lecture.raw.md`);
    migrated++;
  }
}

// Update DB paths
if (fs.existsSync(DB_PATH)) {
  const db = new Database(DB_PATH);
  const rows = db.prepare("SELECT id, notes_file FROM lectures WHERE notes_file IS NOT NULL").all() as Array<{
    id: string;
    notes_file: string;
  }>;

  let dbUpdated = 0;
  const updateStmt = db.prepare("UPDATE lectures SET notes_file = ? WHERE id = ?");

  for (const row of rows) {
    const oldPath = row.notes_file;
    // Convert file path to directory path (strip .md, that's the new dir)
    if (oldPath.endsWith(".md")) {
      const baseName = path.basename(oldPath, ".md");
      const parentDir = path.dirname(oldPath);
      const newDir = path.join(parentDir, baseName);
      updateStmt.run(newDir, row.id);
      dbUpdated++;
    }
  }

  db.close();
  console.log(`\nDB: updated ${dbUpdated} notes_file paths`);
}

console.log(`\nDone: ${migrated} migrated, ${skipped} skipped`);

/**
 * Lecture titles to skip, from ignored-lectures.txt at the project root.
 *
 * One title per line, `#` for comments. Matching is case-insensitive and
 * whitespace-trimmed because these are copied by hand out of Panopto listings.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";

export const IGNORE_FILE = path.join(CONFIG.rootDir, "ignored-lectures.txt");

export function loadIgnoredTitles(): Set<string> {
  if (!fs.existsSync(IGNORE_FILE)) return new Set();
  return new Set(
    fs
      .readFileSync(IGNORE_FILE, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.toLowerCase()),
  );
}

export function isIgnoredTitle(title: string, ignored: Set<string>): boolean {
  return ignored.has(title.toLowerCase().trim());
}

/** Append a title, ignoring duplicates. Returns true if the file changed. */
export function addIgnoredTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  if (isIgnoredTitle(trimmed, loadIgnoredTitles())) return false;

  const prefix = fs.existsSync(IGNORE_FILE) ? "" : "# Lecture titles to skip, one per line.\n";
  fs.appendFileSync(IGNORE_FILE, `${prefix}${trimmed}\n`, "utf-8");
  return true;
}

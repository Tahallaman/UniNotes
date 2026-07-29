/**
 * Where each lecture's note was last written, so changing a template moves the
 * file rather than leaving a second copy of it.
 *
 * The problem this solves is the cost of the rule that everything else here
 * follows — nothing at a destination is ever moved or deleted. That rule is
 * right: those folders are yours, and a tool that rearranges an Obsidian vault
 * because you edited a text box is a tool you stop trusting. But it means every
 * template change doubles the folder: the same note under both names, identical
 * but for what they are called, and no way to tell which one is current.
 *
 * So a note is moved in exactly one circumstance: this file says we put it
 * somewhere, and we are now putting it somewhere else. Anything not recorded
 * here is left alone, which covers every file you filed, renamed or wrote
 * yourself.
 *
 * A JSON file at the destination root rather than a column in the database,
 * because the ledger describes a *folder*. Point the workspace at a different
 * drive and the new one is correctly empty; restore an old folder from backup
 * and its ledger comes back with it.
 *
 * Not authoritative, and treated that way throughout. A missing, corrupt or
 * hand-edited ledger costs you a rename, never a note: the copy still happens,
 * and the worst case is the duplicate you would have had anyway.
 */

import fs from "node:fs";
import path from "node:path";

const LEDGER_NAME = ".uninotes-exports.json";

/** lecture key → path of the note we last wrote, relative to the root. */
export type Ledger = Record<string, string>;

export function ledgerPath(root: string): string {
  return path.join(root, LEDGER_NAME);
}

export function readLedger(root: string): Ledger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ledgerPath(root), "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const ledger: Ledger = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) ledger[key] = value;
    }
    return ledger;
  } catch {
    // No ledger yet, or one we can't read. Either way: nothing is recorded, so
    // nothing gets moved, and this run writes a fresh one.
    return {};
  }
}

export function writeLedger(root: string, ledger: Ledger): void {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(ledgerPath(root), `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
  } catch {
    // Non-fatal by design: failing an export because a bookkeeping file wouldn't
    // write would trade the notes for the tidiness.
  }
}

export type MoveOutcome =
  | { kind: "moved"; from: string; to: string }
  | { kind: "blocked"; from: string; to: string }
  | { kind: "none" };

/**
 * Move a previously written note onto its new path.
 *
 * Renaming rather than copying-then-deleting keeps the mtime, which is what the
 * up-to-date check compares — so a moved note isn't then rewritten for no
 * reason.
 *
 * Never overwrites. If something already sits at the new path, the old copy
 * stays where it is and the caller reports both, because deciding which of two
 * files is the real one is a judgement about your notes folder rather than a
 * file operation.
 */
export function moveRecorded(root: string, previous: string, next: string): MoveOutcome {
  if (previous === next) return { kind: "none" };

  const from = path.join(root, previous);
  const to = path.join(root, next);
  if (!fs.existsSync(from)) return { kind: "none" };
  if (fs.existsSync(to)) return { kind: "blocked", from: previous, to: next };

  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  } catch {
    return { kind: "blocked", from: previous, to: next };
  }
  return { kind: "moved", from: previous, to: next };
}

/**
 * What a note was called before any of the templating existed: the lecture's
 * folder name, with .md on the end, directly under the course.
 *
 * Seeds the ledger for folders that predate it, so the first run after
 * upgrading migrates rather than duplicating. Only consulted when the ledger
 * has nothing for that lecture, and only when a file is actually sitting there
 * under that exact name.
 */
export function legacyPath(courseCode: string, lectureDirName: string): string {
  return `${courseCode}/${lectureDirName}.md`;
}

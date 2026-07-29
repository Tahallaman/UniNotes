/**
 * Regression test for the export ledger (src/notes/exportLedger.ts).
 *
 * This is the only code in the project that moves a file in a folder the user
 * owns, so the tests that matter are the ones about restraint: a file it never
 * wrote is never touched, and a name already taken is never overwritten. Both
 * failures are silent and land in an Obsidian vault.
 *
 * Runs against a scratch directory under temp/, created and removed here.
 *
 *   npm run test:ledger
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLedger,
  writeLedger,
  moveRecorded,
  legacyPath,
  ledgerPath,
} from "../src/notes/exportLedger.js";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uninotes-ledger-"));
const write = (relative: string, body = "notes") => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const exists = (relative: string) => fs.existsSync(path.join(root, relative));

try {
  // ── Round trip ────────────────────────────────────────────────────────────
  check("an absent ledger reads as empty", Object.keys(readLedger(root)).length === 0);

  writeLedger(root, { a: "COMPSYS 730/Lecture 01.md" });
  check("what was written comes back", readLedger(root).a === "COMPSYS 730/Lecture 01.md");

  fs.writeFileSync(ledgerPath(root), "{ not json");
  check("a corrupt ledger reads as empty rather than throwing", Object.keys(readLedger(root)).length === 0);

  fs.writeFileSync(ledgerPath(root), JSON.stringify({ a: 12, b: "ok/x.md" }));
  const cleaned = readLedger(root);
  check("non-string entries are dropped", cleaned.a === undefined && cleaned.b === "ok/x.md");

  // ── Moving ────────────────────────────────────────────────────────────────
  write("COMPSYS 730/old name.md");
  const moved = moveRecorded(root, "COMPSYS 730/old name.md", "COMPSYS 730/Lecture 01 - COMPSYS 730.md");
  check("a recorded note moves to its new name", moved.kind === "moved");
  check("and is gone from the old one", !exists("COMPSYS 730/old name.md"));
  check("and is at the new one", exists("COMPSYS 730/Lecture 01 - COMPSYS 730.md"));

  // Templates can change a folder as well as a filename.
  write("SOFTENG 761/note.md");
  const across = moveRecorded(root, "SOFTENG 761/note.md", "Semester 1/SOFTENG 761/Week 3/note.md");
  check("a move into a folder that doesn't exist yet still works", across.kind === "moved");
  check("and lands there", exists("Semester 1/SOFTENG 761/Week 3/note.md"));

  // ── Restraint ─────────────────────────────────────────────────────────────
  const same = moveRecorded(root, "COMPSYS 730/x.md", "COMPSYS 730/x.md");
  check("an unchanged name is not a move", same.kind === "none");

  const absent = moveRecorded(root, "COMPSYS 730/never written.md", "COMPSYS 730/new.md");
  check("a recorded file that isn't there is left alone", absent.kind === "none");

  // The case that matters most: something already at the destination. Losing
  // this one silently overwrites a note the user may have edited.
  write("ENGGEN 403/from.md", "the old export");
  write("ENGGEN 403/to.md", "something already here");
  const blocked = moveRecorded(root, "ENGGEN 403/from.md", "ENGGEN 403/to.md");
  check("an occupied destination blocks the move", blocked.kind === "blocked");
  check("the old file stays where it was", exists("ENGGEN 403/from.md"));
  check(
    "and the file already there is untouched",
    fs.readFileSync(path.join(root, "ENGGEN 403/to.md"), "utf-8") === "something already here",
  );

  // ── The pre-template name ─────────────────────────────────────────────────
  check(
    "legacy path is the lecture folder under its course",
    legacyPath("ENGGEN 403", "ENGGEN 403 [21 July] Lecture 1") ===
      "ENGGEN 403/ENGGEN 403 [21 July] Lecture 1.md",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

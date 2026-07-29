/**
 * Regression test for export filenames (src/notes/exportName.ts).
 *
 * Every case below is a real Panopto title from a real course. They are the
 * point of the module: three departments, three conventions, and no two of them
 * putting the lecture number in the same place — or in it at all.
 *
 * The failure this guards against is quiet. A number parsed out of the wrong
 * digits still produces a plausible filename; it just files lecture 2 of the
 * course under 76, next to nothing, sorted nowhere near the lecture it follows.
 *
 * Pure string manipulation: no filesystem, no network.
 *
 *   npm run test:export-names
 */

import {
  buildExportNames,
  describeRest,
  parseLectureNumber,
  titleMonthDay,
  type LectureEntry,
} from "../src/notes/exportName.js";

const checks: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
  checks.push([name, ok]);
}

// ── Numbers stated in the title ───────────────────────────────────────────
check("word form", parseLectureNumber("ENGGEN 403 [21 July] Lecture 1 What can it do") === 1);
check("word form, padded", parseLectureNumber("COMPSCI 351 Lecture 07 - Joins") === 7);
check("word form, abbreviated", parseLectureNumber("Lec 4 — Transactions") === 4);
check("panopto code form", parseLectureNumber("[405-422] SOFTENG 761 L02 - Wed 22 Jul") === 2);
check("code form with stream suffix", parseLectureNumber("SOFTENG 761 L01C - Mon 20 Jul") === 1);
check("word form beats code form", parseLectureNumber("SOFTENG 761 L05 Lecture 2 - Agile") === 2);
check("no number stated", parseLectureNumber("SOFTENG 753 - Tue 21 Jul - What is Deep Learning") === null);

// The course code is three digits followed by nothing, and a single-digit "L"
// form is far more often a concept than a lecture.
check("course code is not a lecture number", parseLectureNumber("SOFTENG 761 - Wed 22 Jul") === null);
check("L2 regularisation is not lecture 2", parseLectureNumber("SOFTENG 753 - L2 Regularisation") === null);
check("lecture notes without a number", parseLectureNumber("COMPSYS 730 Lecture Notes - Intro") === null);

// ── What survives into the name ───────────────────────────────────────────
check(
  "leading course code and number removed, sentence intact",
  describeRest("ENGGEN 403 [21 July] Lecture 1 What can ENGGEN 403 do for me", "ENGGEN 403") ===
    "[21 July] What can ENGGEN 403 do for me",
);
check(
  "panopto folder id dropped, repeated code unwound",
  describeRest(
    "[423-348] SOFTENG 761 L01CSOFTENG 761 L02C - Mon 20 Jul 0200 PM (NZT)",
    "SOFTENG 761",
  ) === "Mon 20 Jul 0200 PM (NZT)",
);
check(
  "date-only title keeps its date",
  describeRest("SOFTENG 753 - Thu 23 Jul - Mathematical Building Blocks", "SOFTENG 753") ===
    "Thu 23 Jul - Mathematical Building Blocks",
);

// ── Whole-course naming ───────────────────────────────────────────────────
const enggen = buildExportNames("ENGGEN 403", [
  { name: "ENGGEN 403 [24 July] Lecture 3 Interface of science", sortKey: 3 },
  { name: "ENGGEN 403 [21 July] Lecture 1 What can ENGGEN 403 do for me", sortKey: 1 },
]);
check(
  "stated numbers used as given",
  enggen.get("ENGGEN 403 [21 July] Lecture 1 What can ENGGEN 403 do for me") ===
    "Lecture 01 - ENGGEN 403 - [21 July] What can ENGGEN 403 do for me.md",
);
check(
  "third lecture keeps its own number",
  enggen.get("ENGGEN 403 [24 July] Lecture 3 Interface of science") ===
    "Lecture 03 - ENGGEN 403 - [24 July] Interface of science.md",
);

// ── Dates read out of titles ──────────────────────────────────────────────
check("day-first date", titleMonthDay("SOFTENG 753 - Tue 21 Jul - Intro") === 721);
check("month spelled out", titleMonthDay("ENGGEN 403 [21 July] Lecture 1") === 721);
check("december reads as 12", titleMonthDay("Recap - 3 Dec") === 1203);
check("no date in the title", titleMonthDay("SOFTENG 761 Agile and Lean") === null);

// The year is deliberately not part of this. Gemini dated SOFTENG 753's 23 July
// recording 2020-07-23; against a sibling dated from the current year, any key
// carrying the year sorts the semester backwards.
check(
  "23 Jul sorts after 21 Jul whatever the year says",
  titleMonthDay("Thu 23 Jul")! > titleMonthDay("Tue 21 Jul")!,
);

// SOFTENG 753 states no numbers at all: the order is the delivery order, and
// the map must not depend on the order the folders were read in.
const unnumbered: LectureEntry[] = [
  { name: "SOFTENG 753 - Thu 23 Jul - Mathematical Building Blocks", sortKey: titleMonthDay("Thu 23 Jul")! },
  { name: "SOFTENG 753 - Tue 21 Jul - Introduction & What is Deep Learning", sortKey: titleMonthDay("Tue 21 Jul")! },
];
const softeng753 = buildExportNames("SOFTENG 753", unnumbered);
check(
  "unnumbered course numbered by date, not by folder order",
  softeng753.get("SOFTENG 753 - Tue 21 Jul - Introduction & What is Deep Learning") ===
    "Lecture 01 - SOFTENG 753 - Tue 21 Jul - Introduction & What is Deep Learning.md",
);
check(
  "later date takes the later number",
  softeng753.get("SOFTENG 753 - Thu 23 Jul - Mathematical Building Blocks") ===
    "Lecture 02 - SOFTENG 753 - Thu 23 Jul - Mathematical Building Blocks.md",
);

// A course that started numbering halfway through: the stated numbers are
// fixed points, and the rest fill the gaps around them in date order.
const mixed = buildExportNames("COMPSYS 730", [
  { name: "COMPSYS 730 Lecture 2 - Scheduling", sortKey: 200 },
  { name: "COMPSYS 730 - Mon 14 Jul - Course intro", sortKey: 100 },
  { name: "COMPSYS 730 - Fri 25 Jul - Interrupts", sortKey: 300 },
]);
check(
  "gap before a stated number is filled",
  mixed.get("COMPSYS 730 - Mon 14 Jul - Course intro") ===
    "Lecture 01 - COMPSYS 730 - Mon 14 Jul - Course intro.md",
);
check(
  "numbering continues past the stated one",
  mixed.get("COMPSYS 730 - Fri 25 Jul - Interrupts") ===
    "Lecture 03 - COMPSYS 730 - Fri 25 Jul - Interrupts.md",
);

// ── The names must stay usable as filenames ───────────────────────────────
const collide = buildExportNames("MECHENG 270", [
  { name: "MECHENG 270 Lecture 1", sortKey: 1 },
  { name: "MECHENG 270 - Lecture 1 -", sortKey: 2 },
]);
check(
  "two titles reducing to one name stay distinct",
  new Set(collide.values()).size === 2,
);
check(
  "illegal filename characters removed",
  !/[<>:"/\\|?*]/.test(
    buildExportNames("PHYSICS 120", [{ name: 'PHYSICS 120 Lecture 4: what/why "energy"?', sortKey: 1 }])
      .get('PHYSICS 120 Lecture 4: what/why "energy"?')!,
  ),
);
check(
  "one-digit width still available",
  buildExportNames("ENGSCI 111", [{ name: "ENGSCI 111 Lecture 4 - Vectors", sortKey: 1 }], 1).get(
    "ENGSCI 111 Lecture 4 - Vectors",
  ) === "Lecture 4 - ENGSCI 111 - Vectors.md",
);

let bad = 0;
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

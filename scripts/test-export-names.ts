/**
 * Regression test for lecture numbering — what fills `{number}` in a template.
 *
 * Every title below is a real one from a real course. They are the point of the
 * thing: three departments, three conventions, and no two of them putting the
 * lecture number in the same place, or in at all.
 *
 * The failure this guards against is quiet. A number parsed out of the wrong
 * digits still produces a plausible filename; it just files lecture 2 of the
 * course under 76, next to nothing, sorted nowhere near the lecture it follows.
 *
 * Scope note: this file used to test filename construction as well. Naming is
 * src/notes/organise.ts now — one template system, covered by test-weeks.ts —
 * so what is left here is the part organise can't do for itself: reading a
 * number out of prose, and ordering the lectures that state none.
 *
 * Pure string manipulation: no filesystem, no network.
 *
 *   npm run test:export-names
 */

import { parseLectureNumber } from "../src/notes/exportName.js";
import { assignLectureNumbers, lectureNumbersByCourse } from "../src/notes/organise.js";

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

// ── Numbering a course ────────────────────────────────────────────────────

const enggen = assignLectureNumbers([
  { key: "c", title: "ENGGEN 403 [24 July] Lecture 3 Interface of science", date: "2026-07-24" },
  { key: "a", title: "ENGGEN 403 [21 July] Lecture 1 What can ENGGEN 403 do for me", date: "2026-07-21" },
]);
check("stated numbers used as given", enggen.get("a") === 1);
check("third lecture keeps its own number", enggen.get("c") === 3);

// SOFTENG 753 states no numbers at all: the order is delivery order, and it must
// not depend on the order the library happened to list them in.
const unnumbered = assignLectureNumbers([
  { key: "later", title: "SOFTENG 753 - Thu 23 Jul - Mathematical Building Blocks", date: "2026-07-23" },
  { key: "first", title: "SOFTENG 753 - Tue 21 Jul - Introduction & What is Deep Learning", date: "2026-07-21" },
]);
check("unnumbered course numbered by date, not by list order", unnumbered.get("first") === 1);
check("later date takes the later number", unnumbered.get("later") === 2);

// A course that started numbering halfway through: the stated numbers are fixed
// points, and the rest fill the gaps around them in date order.
const mixed = assignLectureNumbers([
  { key: "stated2", title: "COMPSYS 730 Lecture 2 - Scheduling", date: "2026-07-18" },
  { key: "intro", title: "COMPSYS 730 - Mon 14 Jul - Course intro", date: "2026-07-14" },
  { key: "interrupts", title: "COMPSYS 730 - Fri 25 Jul - Interrupts", date: "2026-07-25" },
]);
check("gap before a stated number is filled", mixed.get("intro") === 1);
check("the stated number is left where it was", mixed.get("stated2") === 2);
check("numbering continues past the stated one", mixed.get("interrupts") === 3);

// Two recordings both calling themselves lecture 3 happens when one is a
// re-record. Taking both as given surfaces it; inventing a distinction hides it.
const duplicates = assignLectureNumbers([
  { key: "first", title: "PHYSICS 120 Lecture 3 - Waves", date: "2026-07-14" },
  { key: "rerecord", title: "PHYSICS 120 Lecture 3 - Waves (re-record)", date: "2026-07-15" },
]);
check(
  "a repeated stated number is left alone",
  duplicates.get("first") === 3 && duplicates.get("rerecord") === 3,
);

// A lecture with neither a date nor a stated number can't be placed by either,
// so it goes last rather than being guessed into the middle of the course.
const dateless = assignLectureNumbers([
  { key: "nodate", title: "MECHENG 270 - Guest lecture", date: null },
  { key: "dated", title: "MECHENG 270 - Mon 14 Jul - Statics", date: "2026-07-14" },
]);
check("a dateless lecture sorts last", dateless.get("dated") === 1 && dateless.get("nodate") === 2);

// ── Numbering is per course ───────────────────────────────────────────────

const twoCourses = lectureNumbersByCourse([
  { key: "e1", courseCode: "ENGGEN 403", title: "ENGGEN 403 - Mon 14 Jul - Intro", date: "2026-07-14" },
  { key: "c1", courseCode: "COMPSYS 730", title: "COMPSYS 730 - Tue 15 Jul - Intro", date: "2026-07-15" },
  { key: "c2", courseCode: "COMPSYS 730", title: "COMPSYS 730 - Fri 18 Jul - Interrupts", date: "2026-07-18" },
]);
check(
  "each course starts again at one",
  twoCourses.get("e1") === 1 && twoCourses.get("c1") === 1 && twoCourses.get("c2") === 2,
);

let bad = 0;
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

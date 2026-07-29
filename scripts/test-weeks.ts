/**
 * Regression test for term/week resolution and naming (src/notes/organise.ts).
 *
 * The failure this mostly guards against is silent and plausible: a lecture
 * filed into week 8 when it belongs in week 6. Nothing errors, the file lands
 * somewhere sensible-looking, and you only notice weeks later when the folder
 * you're revising from is missing a lecture.
 *
 * The break arithmetic is the reason. The dates below are taken from real
 * exported notes — a semester whose recordings run 2 Mar → 1 Apr, stop dead,
 * and resume 20 Apr. Counting weeks by division puts that 20 Apr lecture in
 * week 8; it is the first week back, week 6.
 *
 * Pure functions: no browser, no network, no database.
 *
 *   npm run test:weeks
 */

import {
  cleanTitle,
  destinationFor,
  findTerm,
  parseIsoDate,
  parseListingDate,
  parseTitleDate,
  renderTemplate,
  resolveDate,
  validateTerms,
  weekOf,
  type Term,
} from "../src/notes/organise.js";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// ── Terms ─────────────────────────────────────────────────────────────────────

const s1: Term = {
  id: "2026-s1",
  label: "2026 Semester 1",
  folder: "Semester 1",
  start: "2026-03-02",
  weeks: 12,
  break: { afterWeek: 5, weeks: 2 },
};

const s2: Term = {
  id: "2026-s2",
  label: "2026 Semester 2",
  folder: "",
  start: "2026-07-20",
  weeks: 12,
  break: { afterWeek: 6, weeks: 2 },
};

const terms = [s1, s2];

const weekFor = (iso: string, term: Term) => {
  const date = parseIsoDate(iso);
  return date ? weekOf(date, term) : null;
};

// Real lecture dates from Exports/Pretty/COMPSCI 732.
check("first Friday is week 1", weekFor("2026-03-06", s1) === 1);
check("start date itself is week 1", weekFor("2026-03-02", s1) === 1);
check("last day of week 1 is still week 1", weekFor("2026-03-08", s1) === 1);
check("27 Mar is week 4", weekFor("2026-03-27", s1) === 4);
check("1 Apr is week 5 — the last before the break", weekFor("2026-04-01", s1) === 5);

// The whole point: without break handling this is week 8.
check("20 Apr is week 6, the first week back", weekFor("2026-04-20", s1) === 6);
check("24 Apr is still week 6", weekFor("2026-04-24", s1) === 6);
check("8 May is week 8", weekFor("2026-05-08", s1) === 8);

check("a recording during the break clamps back to week 5", weekFor("2026-04-08", s1) === 5);
check("before the term starts has no week", weekFor("2026-02-01", s1) === null);
check("past the last teaching week clamps to the last", weekFor("2027-01-01", s1) === 12);

// Second semester, real dates from the current lectures.
check("21 Jul is S2 week 1", weekFor("2026-07-21", s2) === 1);
check("28 Jul is S2 week 2", weekFor("2026-07-28", s2) === 2);

// A term with no break is plain arithmetic.
const noBreak: Term = { ...s1, id: "flat", break: null };
check("without a break, 20 Apr is week 8", weekFor("2026-04-20", noBreak) === 8);

// ── Which term ────────────────────────────────────────────────────────────────

const termFor = (iso: string) => {
  const date = parseIsoDate(iso);
  return date ? findTerm(date, terms) : null;
};

check("March lands in semester 1", termFor("2026-03-10")?.id === "2026-s1");
check("July lands in semester 2", termFor("2026-07-28")?.id === "2026-s2");
check("the winter gap belongs to neither", termFor("2026-06-15") === null);
check("a year later belongs to neither", termFor("2027-03-10") === null);

check("a sound term list has no problems", validateTerms(terms).length === 0);
check(
  "overlapping terms are rejected",
  validateTerms([s1, { ...s2, id: "clash", start: "2026-04-01" }]).some((p) =>
    p.message.includes("Overlaps"),
  ),
);
check(
  "a break past the end of the term is rejected",
  validateTerms([{ ...s1, id: "bad", break: { afterWeek: 20, weeks: 2 } }]).length > 0,
);
check(
  "an impossible start date is rejected",
  validateTerms([{ ...s1, id: "bad2", start: "2026-02-31" }]).length > 0,
);

// ── Dates out of titles ───────────────────────────────────────────────────────

// Copied verbatim from the database, backslashes and all. Panopto joins the two
// stream names with one, and an earlier version of these tests quietly dropped
// it — which hid a bug that put a double dash in every COMPSYS filename.
const real = [
  "[423-348] COMPSYS 730 L01C\\COMPSYS 730 L02C - Tue 28 Jul 10:00 AM (NZT)",
  "[109-B28] COMPSCI 732 L01C\\COMPSCI 732 L02C - Fri 06 Mar 04:00 PM (NZT)",
  "ENGGEN 403 [28 July] Lecture 4 Business Case Analysis",
  "[405-422] SOFTENG 761 Lecture 2 - Wed 22 Jul 10:00 AM (NZT)",
  "[421W-201] COMPSYS 730 T01C\\COMPSYS 730 T02C - Thu 23 Jul 10:00 AM (NZT)",
];

check("title date: day-month with weekday", parseTitleDate(real[0], terms) === "2026-07-28");
check("title date: March lands in S1's year", parseTitleDate(real[1], terms) === "2026-03-06");
check("title date: bracketed '28 July'", parseTitleDate(real[2], terms) === "2026-07-28");
check("title date: mid-title date", parseTitleDate(real[3], terms) === "2026-07-22");
check("title date: an explicit year wins", parseTitleDate("Lecture 2025-09-01", terms) === "2025-09-01");
check("title date: nothing to find", parseTitleDate("Week 3 tutorial", terms) === null);
check(
  "title date: 30 Feb is not a date",
  parseTitleDate("Lecture 30 Feb", terms) === null,
);

// ── Panopto's Date column ─────────────────────────────────────────────────────

// The format the Auckland tenant actually serves, confirmed by the probe.
check("month-first, as Panopto renders it here", parseListingDate("7/28/2026") === "2026-07-28");
check("day-first when the day can't be a month", parseListingDate("28/07/2026") === "2026-07-28");
check("a month name parses", parseListingDate("Jul 28, 2026") === "2026-07-28");
check("two-digit years", parseListingDate("7/28/26") === "2026-07-28");
check("an unrendered binding is not a date", parseListingDate("{binding StartTime}") === null);
check("blank is not a date", parseListingDate("   ") === null);
check("nonsense is not a date", parseListingDate("13/45/2026") === null);

// ── Which source wins ─────────────────────────────────────────────────────────

const inputs = {
  title: "Lecture - Tue 28 Jul 1000 AM",
  recordedAt: "2026-07-27T02:00:00Z",
  dateOverride: "2026-07-25",
  frontmatterDate: "2026-07-01",
};

check("a hand-set date beats everything", resolveDate(inputs, terms).date === "2026-07-25");
check("source is reported as manual", resolveDate(inputs, terms).source === "manual");
check(
  "without an override, Panopto wins",
  resolveDate({ ...inputs, dateOverride: null }, terms).date === "2026-07-27",
);
check(
  "without Panopto, the title wins",
  resolveDate({ ...inputs, dateOverride: null, recordedAt: null }, terms).date === "2026-07-28",
);
check(
  "frontmatter is the last resort",
  resolveDate({ dateOverride: null, recordedAt: null, title: "no date here", frontmatterDate: "2026-07-01" }, terms)
    .source === "frontmatter",
);
check("nothing at all resolves to null", resolveDate({ title: "no date here" }, terms).date === null);

// ── Tidy titles ───────────────────────────────────────────────────────────────

check(
  "room code, doubled course code, streams and timestamp all go",
  cleanTitle(real[0], "COMPSYS 730") === "",
);
check(
  "the slash joining two streams doesn't survive as a title",
  cleanTitle(real[4], "COMPSYS 730") === "",
);
check(
  "a real lecture name survives",
  cleanTitle(real[2], "ENGGEN 403") === "Lecture 4 Business Case Analysis",
);
check("the useful part is kept", cleanTitle(real[3], "SOFTENG 761") === "Lecture 2");
check(
  "a title that is already tidy is left alone",
  cleanTitle("Introduction to Systems Thinking", "ENGGEN 403") === "Introduction to Systems Thinking",
);
// The code as scaffolding goes; the code as a word in the sentence stays.
check(
  "a course code inside the sentence survives",
  cleanTitle("ENGGEN 403 [21 July] Lecture 1 What can ENGGEN 403 do for me?", "ENGGEN 403") ===
    "Lecture 1 What can ENGGEN 403 do for me?",
);

// ── Templates ─────────────────────────────────────────────────────────────────

const full = { course: "COMPSYS 730", title: "Lecture 4", date: "2026-07-28", week: "2" };

check(
  "everything present",
  renderTemplate("{course} - {title} - {date}", full) === "COMPSYS 730 - Lecture 4 - 2026-07-28",
);
check(
  "a missing date takes its dash with it",
  renderTemplate("{course} - {title} - {date}", { ...full, date: "" }) === "COMPSYS 730 - Lecture 4",
);
check(
  "a missing middle token doesn't leave two dashes",
  renderTemplate("{course} - {title} - {date}", { ...full, title: "" }) === "COMPSYS 730 - 2026-07-28",
);
check(
  "everything missing collapses to nothing",
  renderTemplate("{title} - {date}", { title: "", date: "" }) === "",
);
check(
  "the week can be put in the name",
  renderTemplate("W{week} {course} - {title}", full) === "W2 COMPSYS 730 - Lecture 4",
);

// ── Destinations ──────────────────────────────────────────────────────────────

const workspace = {
  folderTemplate: "{term}/{course}/Week {week}/Lectures",
  fileTemplate: "{course} - {title} - {date}",
};

const current = destinationFor(
  { title: real[0], courseCode: "COMPSYS 730", resolvedDate: "2026-07-28" },
  workspace,
  terms,
  true,
);
check(
  "current term has no term folder",
  current.segments.join("/") === "COMPSYS 730/Week 2/Lectures",
);
check("filename drops the empty title", current.filename === "COMPSYS 730 - 2026-07-28.md");
check("and leaves no double dash behind", !current.filename.includes(" - - "));

const archived = destinationFor(
  { title: "Lecture 3 Systems", courseCode: "COMPSCI 732", resolvedDate: "2026-04-20" },
  workspace,
  terms,
  true,
);
check(
  "an archived term adds its folder",
  archived.segments.join("/") === "Semester 1/COMPSCI 732/Week 6/Lectures",
);

const undated = destinationFor(
  { title: "Some talk", courseCode: "SOFTENG 700" },
  workspace,
  terms,
  true,
);
check(
  "no date means no week folder — not an Unsorted one",
  undated.segments.join("/") === "SOFTENG 700/Lectures",
);
check("an undated lecture still gets a sensible name", undated.filename === "SOFTENG 700 - Some talk.md");

const outsideTerms = destinationFor(
  { title: "Holiday recap", courseCode: "SOFTENG 700", resolvedDate: "2026-06-15" },
  workspace,
  terms,
  true,
);
check(
  "a date outside every term skips the week folder",
  outsideTerms.segments.join("/") === "SOFTENG 700/Lectures",
);

const weeksOff = destinationFor(
  { title: "Lecture 3 Systems", courseCode: "COMPSCI 732", resolvedDate: "2026-04-20" },
  workspace,
  terms,
  false,
);
check(
  "weeks switched off removes term and week folders",
  weeksOff.segments.join("/") === "COMPSCI 732/Lectures",
);
check("weeks off still names the file by date", weeksOff.filename === "COMPSCI 732 - Lecture 3 Systems - 2026-04-20.md");

const flat = destinationFor(
  { title: real[2], courseCode: "ENGGEN 403", resolvedDate: "2026-07-28" },
  { folderTemplate: "{course}", fileTemplate: "{course} - {title} - {date}" },
  terms,
  true,
);
check("the flat Exports layout still works", flat.segments.join("/") === "ENGGEN 403");
check(
  "and gets a tidy name",
  flat.filename === "ENGGEN 403 - Lecture 4 Business Case Analysis - 2026-07-28.md",
);

const nasty = destinationFor(
  { title: 'A/B testing: "why?" <slides>', courseCode: "SOFTENG 700", resolvedDate: "2026-07-28" },
  { folderTemplate: "{course}", fileTemplate: "{title}" },
  terms,
  true,
);
check("characters Windows rejects are stripped", nasty.filename === "AB testing why slides.md");

// ── Report ────────────────────────────────────────────────────────────────────

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

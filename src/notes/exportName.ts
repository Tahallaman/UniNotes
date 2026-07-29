/**
 * Work out what each lecture's notes are called once they leave Lectures/.
 *
 * Panopto titles arrive in whatever shape the department typed them:
 *
 *   ENGGEN 403 [21 July] Lecture 1 What can ENGGEN 403 do for me
 *   SOFTENG 753 - Tue 21 Jul - Introduction & What is Deep Learning
 *   [423-348] SOFTENG 761 L01CSOFTENG 761 L02C - Mon 20 Jul 0200 PM (NZT)
 *
 * Filed under those names, a course folder sorts by whichever of a Panopto
 * folder ID, a course code or a weekday the title happens to start with — three
 * orderings, none of them the order the lectures were given in. So exported
 * notes lead with the lecture number instead:
 *
 *   Lecture 01 - ENGGEN 403 - [21 July] What can ENGGEN 403 do for me.md
 *
 * The number comes from the title when the title states one, and from the order
 * the lectures were delivered when it doesn't. That fallback is why this works a
 * course at a time rather than a lecture at a time: "the third lecture" is not a
 * fact about one recording, it is a fact about its siblings.
 *
 * Lectures/ itself is untouched. The folder name there is the recording's title
 * verbatim, and that is what the pipeline matches on to know a lecture has
 * already been processed — rename it and every lecture looks new again.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";

/** "Lecture 3", "Lecture 03", "Lec 3" — how a title usually says it in words. */
const WORD_FORM = /\b(?:lectures?|lect|lec)\.?\s*0*(\d{1,2})\b/gi;

/**
 * Panopto's own form: L01, L02C, L10.
 *
 * Two digits are required deliberately. A one-digit rule would read "L2
 * Regularisation" as lecture 2 and "L1 cache" as lecture 1, and a lecture titled
 * after a concept is far more common than one numbered "L1".
 */
const CODE_FORM = /\bL0*(\d{2})[A-Z]?/g;

/** A Panopto folder ID stuck on the front, e.g. "[423-348] ". Never informative. */
const FOLDER_ID_PREFIX = /^\s*\[[0-9A-Za-z]{1,6}-[0-9A-Za-z]{1,6}\]\s*/;

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/** "21 July", "20 Jul" — the date form these titles carry, day first. */
const TITLE_DATE = new RegExp(`\\b(\\d{1,2})\\s*(${MONTHS.join("|")})[a-z]*\\b`, "i");

/** Seconds since the epoch fit under this, so it can sit below the month/day. */
const TIEBREAK_SCALE = 1e10;

/** Longest a generated name may get, before ".md". Titles can be paragraphs. */
const MAX_BASENAME = 120;

export interface LectureEntry {
  /** The lecture's folder name under Lectures/<Course>/ — its Panopto title. */
  name: string;
  /**
   * Where the lecture falls in the course, as a sortable number. Only consulted
   * for lectures whose title states no number, and only against its siblings,
   * so any consistent scale works — see lectureOrderKey for the one on disk.
   */
  sortKey: number;
}

/**
 * The lecture number a title states, or null when it states none.
 *
 * The word form wins over the code form: a title carrying both ("Lecture 2" in
 * a folder called L02C) states the same number twice, and where they disagree
 * the prose is the one a human wrote on purpose.
 */
export function parseLectureNumber(title: string): number | null {
  const word = firstMatch(title, WORD_FORM);
  if (word !== null) return word;
  return firstMatch(title, CODE_FORM);
}

function firstMatch(title: string, pattern: RegExp): number | null {
  // Fresh regex per call: the module-level patterns are /g and carry lastIndex.
  const re = new RegExp(pattern.source, pattern.flags);
  const m = re.exec(title);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What's left of a title once the parts the new name already says are removed:
 * the folder ID, the number, and the course code where it leads.
 *
 * The course code is only stripped from the front, never throughout. "What can
 * ENGGEN 403 do for me" is a sentence about the course, and a rule that removed
 * every occurrence would leave "What can do for me" — the title reduced to
 * nonsense to save eleven characters that only lead the string once.
 */
export function describeRest(title: string, courseCode: string): string {
  let s = title.replace(FOLDER_ID_PREFIX, "");
  s = s.replace(new RegExp(WORD_FORM.source, WORD_FORM.flags), " ");
  s = s.replace(new RegExp(CODE_FORM.source, CODE_FORM.flags), " ");

  // Repeatedly, because one strip can expose another: "[423-348] SOFTENG 761
  // L01C SOFTENG 761 L02C - ..." has the code leading twice once the numbers go.
  const leadingCode = new RegExp(`^[\\s\\-–—:|,]*${courseCodePattern(courseCode)}\\b`, "i");
  let previous = "";
  while (s !== previous) {
    previous = s;
    s = s.replace(leadingCode, "");
  }

  return tidy(s);
}

/** Course codes are written with, without, or with odd spacing: SOFTENG 761, SOFTENG761. */
function courseCodePattern(courseCode: string): string {
  return courseCode
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:|,]+/, "")
    .replace(/[\s\-–—:|,]+$/, "")
    .trim();
}

/**
 * Name every lecture in one course, as a map of folder name → export filename.
 *
 * Numbers stated in titles are taken as given, including duplicates — two
 * recordings both calling themselves lecture 3 is a thing that happens when one
 * is a re-record, and inventing a distinction here would only hide it. Lectures
 * with no stated number are numbered in date order, into the gaps the stated
 * ones leave, so the two schemes can coexist in a course that changed its mind
 * halfway through the semester.
 */
export function buildExportNames(
  courseCode: string,
  entries: readonly LectureEntry[],
  digits: number = CONFIG.exportNaming.numberDigits,
): Map<string, string> {
  const numbers = new Map<string, number>();
  const unnumbered: LectureEntry[] = [];

  for (const entry of entries) {
    const stated = parseLectureNumber(entry.name);
    if (stated !== null) numbers.set(entry.name, stated);
    else unnumbered.push(entry);
  }

  const taken = new Set(numbers.values());
  let next = 1;
  for (const entry of [...unnumbered].sort((a, b) => a.sortKey - b.sortKey)) {
    while (taken.has(next)) next++;
    numbers.set(entry.name, next);
    taken.add(next);
  }

  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const entry of entries) {
    const number = String(numbers.get(entry.name) ?? 0).padStart(Math.max(1, digits), "0");
    const rest = describeRest(entry.name, courseCode);

    // A title that is nothing but its course code and number leaves no tail —
    // fall back to the original, which is at least unique.
    const base = rest
      ? `Lecture ${number} - ${courseCode} - ${rest}`
      : `Lecture ${number} - ${courseCode}`;

    names.set(entry.name, unique(sanitize(base) || sanitize(entry.name), used));
  }

  return names;
}

/** Two lectures reducing to one name would silently export as one file. */
function unique(base: string, used: Set<string>): string {
  let candidate = `${base}.md`;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${n++}).md`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BASENAME)
    .trim();
}

/** The name a note was exported under before any of this existed. */
export function legacyExportName(lectureDirName: string): string {
  return `${lectureDirName}.md`;
}

/**
 * Name every lecture in a course on disk.
 *
 * Reads the notes only for lectures whose title states no number, since that is
 * the only case where the date matters.
 */
export function exportNamesForCourse(courseCode: string, courseDir: string): Map<string, string> {
  const entries: LectureEntry[] = [];

  for (const name of fs.readdirSync(courseDir)) {
    const dir = path.join(courseDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    entries.push({
      name,
      // Only read for lectures that state no number, so only computed for them.
      sortKey: parseLectureNumber(name) !== null ? 0 : lectureOrderKey(dir),
    });
  }

  if (!CONFIG.exportNaming.enabled) {
    return new Map(entries.map((e) => [e.name, legacyExportName(e.name)]));
  }

  return buildExportNames(courseCode, entries);
}

/** The export filename for one lecture folder. */
export function exportNameFor(courseCode: string, lectureDir: string): string {
  const name = path.basename(lectureDir);
  if (!CONFIG.exportNaming.enabled) return legacyExportName(name);

  try {
    const names = exportNamesForCourse(courseCode, path.dirname(lectureDir));
    return names.get(name) ?? legacyExportName(name);
  } catch {
    // Naming is a convenience; a course folder that can't be read is not a
    // reason to fail an export or lose a lecture's notes.
    return legacyExportName(name);
  }
}

/**
 * Where a lecture falls among its siblings, for the courses that number none of
 * their recordings.
 *
 * Deliberately month-and-day only, with the year thrown away. Years here are not
 * reliable: the title never states one, and the frontmatter date is the model's
 * reading of a recording that rarely says — SOFTENG 753's 23 July lecture came
 * back dated 2020-07-23, which against a sibling dated from the file's own year
 * sorts the semester backwards. Month and day are stated plainly in both places
 * and agree with each other, and a course's lectures share a semester, so
 * comparing those alone orders them correctly and a wrong year cannot.
 *
 * (A course spanning New Year would sort January before December. No semester
 * anywhere in the timetable does, and the alternative is trusting a year that
 * has already been observed to be wrong.)
 *
 * The file's mtime breaks ties, and stands in for month and day when neither the
 * notes nor the title gives one: a pipeline that processes lectures as they
 * appear puts them in roughly the right order anyway.
 */
function lectureOrderKey(lectureDir: string): number {
  const notes = ["lecture.pretty.md", "lecture.raw.md"]
    .map((f) => path.join(lectureDir, f))
    .find((f) => fs.existsSync(f));

  const mtime = fs.statSync(notes ?? lectureDir).mtimeMs;
  const monthDay =
    (notes ? frontmatterMonthDay(notes) : null) ??
    titleMonthDay(path.basename(lectureDir)) ??
    monthDayOf(new Date(mtime));

  return monthDay * TIEBREAK_SCALE + Math.floor(mtime / 1000);
}

function monthDayOf(d: Date): number {
  return (d.getMonth() + 1) * 100 + d.getDate();
}

function frontmatterMonthDay(file: string): number | null {
  let head: string;
  try {
    head = fs.readFileSync(file, "utf-8").slice(0, 4096);
  } catch {
    return null;
  }

  // Only inside the frontmatter block: a "date:" line in the body is prose.
  const block = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return null;

  const m = block[1].match(/^date:\s*"?\d{4}-(\d{2})-(\d{2})"?\s*$/m);
  if (!m) return null;

  return Number(m[1]) * 100 + Number(m[2]);
}

/** The month and day a title states, as MMDD — "Tue 21 Jul" → 721. */
export function titleMonthDay(title: string): number | null {
  const m = title.match(TITLE_DATE);
  if (!m) return null;

  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
  if (month === 0) return null;

  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;

  return month * 100 + day;
}

/**
 * Move a note already exported under its old name onto its new one.
 *
 * Renaming rather than re-copying keeps the mtime, which is what the up-to-date
 * checks compare — and it means the change costs one rename per note rather than
 * a folder of duplicates that differ only in what they are called.
 *
 * Never overwrites. If both names exist the old one is left where it is and
 * reported, because at that point deciding which copy is the real one is a
 * judgement about someone's notes folder, not a file operation.
 */
export function renameStaleExport(
  dir: string,
  legacyName: string,
  desiredName: string,
): "renamed" | "conflict" | null {
  if (legacyName === desiredName) return null;

  const from = path.join(dir, legacyName);
  const to = path.join(dir, desiredName);
  if (!fs.existsSync(from)) return null;
  if (fs.existsSync(to)) return "conflict";

  fs.renameSync(from, to);
  return "renamed";
}

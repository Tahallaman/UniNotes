/**
 * Where a lecture's notes belong, and what the file is called.
 *
 * One module rather than logic spread across the two export paths, because the
 * control panel previews destinations *before* anything is written: a preview
 * computed by different code from the writer is a preview that eventually lies.
 * Everything here is pure — dates and templates in, paths out — so the preview
 * endpoint, both export scripts and the per-lecture sync all share one answer.
 *
 * Nothing here stores a week number. A week is a *view* of a date through a term
 * whose start you can edit; storing it would mean correcting a term's start date
 * silently left every lecture filed where it already was.
 */

import path from "node:path";

// ── Terms ─────────────────────────────────────────────────────────────────────

export interface TermBreak {
  /** Teaching week the break follows. A break after week 5 sits between 5 and 6. */
  afterWeek: number;
  weeks: number;
}

export interface Term {
  id: string;
  /** Shown in the panel and available as {termLabel}. */
  label: string;
  /** Folder level for this term, or "" for none — {term}. Blank keeps the
   *  current term at the root while past ones nest under "Semester 1". */
  folder: string;
  /** YYYY-MM-DD — the Monday of week 1. */
  start: string;
  /** Teaching weeks, not counting the break. */
  weeks: number;
  break: TermBreak | null;
}

const DAY_MS = 86_400_000;

/** Parse YYYY-MM-DD as UTC midnight. Local time would shift dates across the
 *  date line for anyone east of UTC, which is the whole of New Zealand. */
export function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  // Rejects 2026-02-31, which Date.UTC would happily roll into March.
  if (date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return date;
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/** Total calendar weeks a term occupies, including its break. */
function spanWeeks(term: Term): number {
  return term.weeks + (term.break?.weeks ?? 0);
}

/** Exclusive end of the term's calendar range. */
export function termEnd(term: Term): Date | null {
  const start = parseIsoDate(term.start);
  if (!start) return null;
  return new Date(start.getTime() + spanWeeks(term) * 7 * DAY_MS);
}

/** The term whose calendar range contains this date, if any. */
export function findTerm(date: Date, terms: readonly Term[]): Term | null {
  for (const term of terms) {
    const start = parseIsoDate(term.start);
    const end = termEnd(term);
    if (!start || !end) continue;
    if (date >= start && date < end) return term;
  }
  return null;
}

/**
 * Teaching week for a date inside a term.
 *
 * The break is why this isn't a division. With a two-week break after week 5,
 * the Monday you come back is week 6, not week 8 — and every lecture after it
 * would otherwise be filed two weeks late for the rest of the term.
 *
 * A recording made *during* the break clamps back to the week before it: those
 * are catch-up sessions, and inventing a "week 5.5" folder helps nobody.
 */
export function weekOf(date: Date, term: Term): number | null {
  const start = parseIsoDate(term.start);
  if (!start) return null;

  const days = daysBetween(start, date);
  if (days < 0) return null;

  const raw = Math.floor(days / 7) + 1;
  let week = raw;

  const brk = term.break;
  if (brk && brk.weeks > 0) {
    if (raw > brk.afterWeek + brk.weeks) week = raw - brk.weeks;
    else if (raw > brk.afterWeek) week = brk.afterWeek;
  }

  return Math.min(Math.max(week, 1), term.weeks);
}

export interface TermProblem {
  termId: string;
  message: string;
}

/**
 * Validate a term list.
 *
 * Overlap is the one that matters: two terms covering the same day makes
 * "which term is this lecture in" answerable two ways, and the answer would
 * then depend on list order.
 */
export function validateTerms(terms: readonly Term[]): TermProblem[] {
  const problems: TermProblem[] = [];

  for (const term of terms) {
    if (term.label.trim().length === 0) {
      problems.push({ termId: term.id, message: "Needs a name." });
    }
    if (!parseIsoDate(term.start)) {
      problems.push({ termId: term.id, message: `Start date "${term.start}" isn't a real date (YYYY-MM-DD).` });
    }
    if (!Number.isInteger(term.weeks) || term.weeks < 1) {
      problems.push({ termId: term.id, message: "Needs at least one teaching week." });
    }
    if (term.break) {
      if (term.break.weeks < 1) {
        problems.push({ termId: term.id, message: "A break must last at least a week — remove it instead." });
      }
      if (term.break.afterWeek < 1 || term.break.afterWeek >= term.weeks) {
        problems.push({
          termId: term.id,
          message: `Break must fall between week 1 and week ${Math.max(term.weeks - 1, 1)}.`,
        });
      }
    }
  }

  const dated = terms
    .map((t) => ({ term: t, start: parseIsoDate(t.start), end: termEnd(t) }))
    .filter((t): t is { term: Term; start: Date; end: Date } => t.start !== null && t.end !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  for (let i = 1; i < dated.length; i++) {
    const previous = dated[i - 1];
    const current = dated[i];
    if (current.start < previous.end) {
      problems.push({
        termId: current.term.id,
        message: `Overlaps ${previous.term.label} (which runs to ${formatIsoDate(previous.end)}).`,
      });
    }
  }

  return problems;
}

// ── Dates out of titles ───────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_WORD = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";

/**
 * Pull a date out of a lecture title.
 *
 * The fallback for anything Panopto didn't date for us: rows scraped before the
 * table view carried a date, and local videos dropped into Incoming/, which
 * never touch Panopto at all. Titles in the wild look like
 * "… - Tue 28 Jul 1000 AM (NZT)" and "ENGGEN 403 [28 July] Lecture 4".
 *
 * Most carry no year, so the year is chosen as the one that lands the date
 * inside a configured term — which is exactly the question being asked of it —
 * falling back to whichever candidate sits closest to `near`.
 */
export function parseTitleDate(
  title: string,
  terms: readonly Term[] = [],
  near?: string | null,
): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(title);
  if (iso) {
    const parsed = parseIsoDate(`${iso[1]}-${iso[2]}-${iso[3]}`);
    if (parsed) return formatIsoDate(parsed);
  }

  const lower = title.toLowerCase();
  let day: number | null = null;
  let month: number | null = null;

  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_WORD}`).exec(lower);
  if (dayFirst) {
    day = Number(dayFirst[1]);
    month = MONTHS[dayFirst[2].slice(0, 3)];
  } else {
    const monthFirst = new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(lower);
    if (monthFirst) {
      month = MONTHS[monthFirst[1].slice(0, 3)];
      day = Number(monthFirst[2]);
    }
  }

  if (day === null || month === undefined || month === null) return null;
  if (day < 1 || day > 31) return null;

  // Pinned into consts so the narrowing above survives into the loop below.
  const monthIndex: number = month;
  const dayOfMonth: number = day;

  /** Null when the day doesn't exist in that month — 31 Feb, 31 Apr. */
  const build = (year: number): Date | null => {
    const date = new Date(Date.UTC(year, monthIndex, dayOfMonth));
    return date.getUTCDate() === dayOfMonth ? date : null;
  };

  const explicitYear = /\b(20\d{2})\b/.exec(title);
  if (explicitYear) {
    const built = build(Number(explicitYear[1]));
    return built ? formatIsoDate(built) : null;
  }

  const anchor = (near ? parseIsoDate(near.slice(0, 10)) : null) ?? new Date();
  const anchorYear = anchor.getUTCFullYear();

  const candidates = [anchorYear - 1, anchorYear, anchorYear + 1]
    .map(build)
    .filter((d): d is Date => d !== null);
  if (candidates.length === 0) return null;

  const inTerm = candidates.find((c) => findTerm(c, terms) !== null);
  if (inTerm) return formatIsoDate(inTerm);

  let best = candidates[0];
  for (const candidate of candidates) {
    if (Math.abs(candidate.getTime() - anchor.getTime()) < Math.abs(best.getTime() - anchor.getTime())) {
      best = candidate;
    }
  }
  return formatIsoDate(best);
}

/**
 * Turn Panopto's rendered Date cell into YYYY-MM-DD.
 *
 * The text comes from Panopto's own `displayDate`, so its format follows the
 * site's locale rather than anything we control: the Auckland tenant renders
 * "7/28/2026", others use day-first or a month name. Month-name forms go to
 * Date; the numeric form is handled here, because "7/28/2026" and "28/07/2026"
 * are the same day written two ways and only one of them is safe to hand over.
 *
 * Returns null rather than guessing. An unreadable date falls back to the
 * title, whereas a wrongly-read one files the lecture in the wrong week and
 * says nothing about it.
 */
export function parseListingDate(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(trimmed);
  if (numeric) {
    const [, first, second, yearText] = numeric;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    // Whichever number can't be a month tells us the order. When both could be
    // (3/4/2026), fall back to month-first — the format Panopto served here.
    const dayFirst = Number(first) > 12;
    const month = dayFirst ? Number(second) : Number(first);
    const day = dayFirst ? Number(first) : Number(second);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCDate() === day ? formatIsoDate(date) : null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rebuilt from local-time parts: Date parses a bare date as UTC but a date
  // with a time as local, and toISOString on the latter can roll the day back.
  return formatIsoDate(
    new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())),
  );
}

export type DateSource = "manual" | "panopto" | "title" | "frontmatter" | null;

export interface DateInputs {
  /**
   * A date a caller already resolved through this same chain. Short-circuits
   * everything below it, so a script iterating the library doesn't re-open note
   * files to re-derive an answer the library worked out once.
   */
  resolvedDate?: string | null;
  resolvedSource?: DateSource;
  dateOverride?: string | null;
  recordedAt?: string | null;
  title?: string | null;
  frontmatterDate?: string | null;
  /** Anchors year inference for a title with no year — the scrape date will do. */
  near?: string | null;
}

export interface ResolvedDate {
  date: string | null;
  source: DateSource;
}

/**
 * Best known date for a lecture, and where it came from.
 *
 * Order is by trustworthiness: a correction you typed beats Panopto's own
 * record, which beats a date scraped out of a title, which beats one the model
 * mentioned while writing notes. The source travels with the date so the panel
 * can say why a lecture is filed where it is.
 */
export function resolveDate(inputs: DateInputs, terms: readonly Term[] = []): ResolvedDate {
  const already = inputs.resolvedDate ? parseIsoDate(inputs.resolvedDate) : null;
  if (already) return { date: formatIsoDate(already), source: inputs.resolvedSource ?? null };

  const override = inputs.dateOverride ? parseIsoDate(inputs.dateOverride) : null;
  if (override) return { date: formatIsoDate(override), source: "manual" };

  const recorded = inputs.recordedAt ? parseIsoDate(inputs.recordedAt.slice(0, 10)) : null;
  if (recorded) return { date: formatIsoDate(recorded), source: "panopto" };

  if (inputs.title) {
    const fromTitle = parseTitleDate(inputs.title, terms, inputs.near);
    if (fromTitle) return { date: fromTitle, source: "title" };
  }

  const frontmatter = inputs.frontmatterDate ? parseIsoDate(inputs.frontmatterDate.slice(0, 10)) : null;
  if (frontmatter) return { date: formatIsoDate(frontmatter), source: "frontmatter" };

  return { date: null, source: null };
}

// ── Tidy titles ───────────────────────────────────────────────────────────────

const WEEKDAYS = /\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/gi;
const TIMEZONE = /\((?:[A-Z]{2,5})\)/g;
const CLOCK = /\b\d{1,2}[:.]?\d{2}\s*(?:am|pm)\b|\b\d{1,2}\s*(?:am|pm)\b/gi;
const STREAM_CODE = /\b[LTS]\d{2}[A-Z]?\b/g;
/** Slashes included: Panopto joins two stream names with one, as in
 *  "COMPSYS 730 L01C\COMPSYS 730 L02C", and once both sides are removed the
 *  slash is left behind as a separator with nothing to separate. */
const SEPARATORS = "-–—_·|/\\\\";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip the scaffolding Panopto bakes into a title, leaving whatever a human
 * would call the lecture.
 *
 * "[423-348] COMPSYS 730 L01CCOMPSYS 730 L02C - Tue 28 Jul 1000 AM (NZT)" is a
 * room number, the course code twice, two stream codes and a timestamp — none of
 * which belong in a filename that already carries the course and the date. That
 * one reduces to nothing, which is correct: the name becomes
 * "COMPSYS 730 - 2026-07-28". "ENGGEN 403 [28 July] Lecture 4 Business Case
 * Analysis" keeps the part that identifies it: "Lecture 4 Business Case Analysis".
 */
export function cleanTitle(raw: string, courseCode?: string | null): string {
  let text = raw;

  // Bracketed room/session ids and bracketed dates alike — neither survives into
  // a tidy name, and both sit in brackets.
  text = text.replace(/\[[^\]]*\]/g, " ");

  if (courseCode && courseCode.trim().length > 0) {
    // Tolerates "COMPSYS730" where the folder says "COMPSYS 730".
    const flexible = escapeRegex(courseCode.trim()).replace(/\\?\s+/g, "\\s*");

    // Where the code is followed by a stream — "COMPSYS 730 L01C\COMPSYS 730
    // L02C" — the pair is scaffolding whole, and both halves go.
    text = text.replace(new RegExp(`${flexible}\\s*[LTS]\\d{2}[A-Z]?`, "gi"), " ");

    // Otherwise only a leading occurrence goes. A course code *inside* the
    // title is usually part of the sentence: "Lecture 1 What can ENGGEN 403 do
    // for me?" reads badly as "What can do for me", and the point of a tidy
    // name is to be readable.
    let previous = "";
    while (previous !== text) {
      previous = text;
      text = text.replace(new RegExp(`^[\\s${SEPARATORS}]*${flexible}`, "i"), " ");
    }
  }

  text = text.replace(STREAM_CODE, " ");
  text = text.replace(TIMEZONE, " ");
  text = text.replace(CLOCK, " ");
  text = text.replace(WEEKDAYS, " ");
  text = text.replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_WORD}\\b`, "gi"), " ");
  text = text.replace(new RegExp(`\\b${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"), " ");
  text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");

  const tidied = tidyJoin(text);

  // Nothing but punctuation left means the title was entirely scaffolding. Say
  // so with an empty string, so the template drops the token and its separators
  // — otherwise a lone stray character survives just long enough to be stripped
  // later as an illegal filename character, leaving "COMPSYS 730 - - date.md".
  return /[\p{L}\p{N}]/u.test(tidied) ? tidied : "";
}

/** Collapse whitespace and strip separators left stranded by a removal. */
function tidyJoin(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(new RegExp(`\\s*([${SEPARATORS}])\\s*(?=[${SEPARATORS}])`, "g"), "")
    .replace(new RegExp(`^[\\s${SEPARATORS}]+`), "")
    .replace(new RegExp(`[\\s${SEPARATORS}]+$`), "")
    .trim();
}

// ── Templates ─────────────────────────────────────────────────────────────────

export type Tokens = Record<string, string>;

/** Marks a token that resolved to nothing, so separators around it can go too. */
const EMPTY = "\u0000";

/**
 * Fill a template, removing the punctuation around anything that resolved to
 * nothing.
 *
 * Without this, a lecture whose date we never worked out is written as
 * "COMPSYS 730 - Lecture 4 - .md". The dangling separator is the difference
 * between a template system and a string replace.
 */
export function renderTemplate(template: string, tokens: Tokens): string {
  const filled = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = tokens[name];
    return value === undefined || value === "" ? EMPTY : value;
  });

  return tidyJoin(
    filled
      .replace(new RegExp(`\\s*[${SEPARATORS}]\\s*${EMPTY}`, "g"), "")
      .replace(new RegExp(`${EMPTY}\\s*[${SEPARATORS}]\\s*`, "g"), "")
      .replace(new RegExp(EMPTY, "g"), ""),
  );
}

/** True when the template references a token that resolved to nothing. */
function hasUnresolvedToken(template: string, tokens: Tokens): boolean {
  const referenced = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  return referenced.some((name) => {
    const value = tokens[name];
    return value === undefined || value === "";
  });
}

/** Windows rejects these outright; the rest is the rule writer.ts already uses. */
export function sanitizeSegment(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120);
}

/**
 * Render a folder template into path segments.
 *
 * A segment whose tokens didn't all resolve is dropped whole rather than
 * rendered half-empty. That is what retires "Unsorted Lectures": a lecture with
 * no date doesn't get a folder announcing the fact, it simply doesn't get a week
 * folder, and lands in "COMPSYS 730/Lectures" beside the ones that did.
 */
export function renderFolderTemplate(template: string, tokens: Tokens): string[] {
  const segments: string[] = [];

  for (const rawSegment of template.split(/[/\\]/)) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    if (hasUnresolvedToken(segment, tokens)) continue;

    const rendered = sanitizeSegment(renderTemplate(segment, tokens));
    if (rendered.length > 0) segments.push(rendered);
  }

  return segments;
}

// ── Putting it together ───────────────────────────────────────────────────────

export interface LectureFacts extends DateInputs {
  title: string;
  courseCode: string;
}

export interface Placement {
  date: string | null;
  dateSource: DateSource;
  term: Term | null;
  week: number | null;
}

/** Date → term → week, the chain every destination is built from. */
export function placeLecture(
  facts: LectureFacts,
  terms: readonly Term[],
  weeksEnabled: boolean,
): Placement {
  const { date, source } = resolveDate(facts, terms);
  if (!date || !weeksEnabled) return { date, dateSource: source, term: null, week: null };

  const parsed = parseIsoDate(date);
  if (!parsed) return { date, dateSource: source, term: null, week: null };

  const term = findTerm(parsed, terms);
  return {
    date,
    dateSource: source,
    term,
    week: term ? weekOf(parsed, term) : null,
  };
}

export function buildTokens(facts: LectureFacts, placement: Placement): Tokens {
  const week = placement.week;
  return {
    course: facts.courseCode ?? "",
    title: cleanTitle(facts.title, facts.courseCode),
    rawTitle: facts.title ?? "",
    date: placement.date ?? "",
    week: week === null ? "" : String(week),
    week2: week === null ? "" : String(week).padStart(2, "0"),
    term: placement.term?.folder ?? "",
    termLabel: placement.term?.label ?? "",
    year: placement.date ? placement.date.slice(0, 4) : "",
  };
}

export interface DestinationTemplates {
  folderTemplate: string;
  fileTemplate: string;
}

export interface Destination {
  /** Path segments below the destination root. */
  segments: string[];
  /** Filename including the .md extension. */
  filename: string;
  placement: Placement;
}

/**
 * Where one lecture's note goes under a destination root.
 *
 * Returns segments rather than a joined path so callers can place it under
 * Exports/Pretty, Exports/Raw or a workspace folder without this needing to know
 * which of those it is working for.
 */
export function destinationFor(
  facts: LectureFacts,
  templates: DestinationTemplates,
  terms: readonly Term[],
  weeksEnabled: boolean,
): Destination {
  const placement = placeLecture(facts, terms, weeksEnabled);
  const tokens = buildTokens(facts, placement);

  const segments = renderFolderTemplate(templates.folderTemplate, tokens);

  // Every token empty would otherwise yield ".md". The raw title is the last
  // thing that is always present, so a file is never nameless.
  const rendered = renderTemplate(templates.fileTemplate, tokens);
  const base = sanitizeSegment(rendered) || sanitizeSegment(facts.title) || "lecture";

  return { segments, filename: `${base}.md`, placement };
}

/** Absolute path for a destination, rooted wherever the caller keeps it. */
export function destinationPath(root: string, destination: Destination): string {
  return path.join(root, ...destination.segments, destination.filename);
}

/**
 * Rebase per-segment timestamps onto the whole-lecture timeline.
 *
 * Each part is uploaded to Gemini as its own video, so the model only ever sees
 * that segment and numbers it from 00:00. Part 2 of a 15-minute split saying
 * "02:00" actually means 17:00 in the real lecture.
 *
 * The shift is done here rather than by asking the model to add the offset
 * itself: the offset is a known constant ((partNum - 1) * segmentSeconds), and a
 * model that quietly miscounts produces a plausible-looking wrong timestamp that
 * nothing downstream can catch. The prompt's only job is to pin the FORMAT so
 * this pass can parse unambiguously.
 */

/** [MM:SS], [H:MM:SS], (MM:SS) — the format the part prompts ask for. */
const BRACKETED = /([[(])(\d{1,2}:[0-5]\d(?::[0-5]\d)?)([\])])/g;

/**
 * A bracketed range: [00:00 - 00:28], [1:02:00–1:05:30].
 *
 * Needed because BRACKETED requires the closing bracket immediately after the
 * timestamp, so a range matched nothing and both ends silently kept the
 * segment-local value — a timestamp that looks right and points at the wrong
 * place in a two-hour recording. Observed as soon as the prompt started
 * demanding timestamps: the model reaches for ranges to describe a span with no
 * content, which is exactly what the prompt asks it to do.
 */
const BRACKETED_RANGE =
  /([[(])(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(\s*[-–—]\s*)(\d{1,2}:[0-5]\d(?::[0-5]\d)?)([\])])/g;

/**
 * A bare timestamp at the start of a line or list item, e.g. "- 02:15 — Topic".
 * Deliberately anchored: an unanchored scan would also rewrite ratios ("3:1"),
 * scores, and verse references scattered through prose.
 */
const LINE_LEADING = /^(\s*(?:[-*+]\s+|#{1,6}\s+|>\s+)?(?:\*\*)?)(\d{1,2}:[0-5]\d(?::[0-5]\d)?)/gm;

/** Clock times ("9:00 AM") are wall-clock, not media offsets — never shift them. */
const FOLLOWED_BY_MERIDIEM = /^\s*(?:[ap]\.?m\.?)/i;

export function parseTimestamp(value: string): number | null {
  const bits = value.split(":").map((n) => parseInt(n, 10));
  if (bits.some((n) => Number.isNaN(n))) return null;
  if (bits.length === 2) return bits[0] * 60 + bits[1];
  if (bits.length === 3) return bits[0] * 3600 + bits[1] * 60 + bits[2];
  return null;
}

/**
 * Format seconds as MM:SS or H:MM:SS.
 * Minutes are always two digits so part 1 (offset 0) and later parts read the
 * same; hours appear only once the lecture passes the hour mark.
 */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Add `offsetSeconds` to every timestamp that looks like a media offset.
 *
 * Runs even at offset 0 (part 1, or an unsplit lecture) so formatting is
 * normalised consistently across the whole document rather than leaving part 1
 * with whatever padding the model happened to emit.
 */
export function shiftTimestamps(markdown: string, offsetSeconds: number): string {
  if (offsetSeconds < 0) return markdown;

  // Ranges first: BRACKETED would otherwise consume neither end, and running it
  // first would leave the range's second timestamp unshifted.
  let out = markdown.replace(
    BRACKETED_RANGE,
    (match, open: string, from: string, dash: string, to: string, close: string) => {
      const a = parseTimestamp(from);
      const b = parseTimestamp(to);
      if (a === null || b === null) return match;
      return `${open}${formatTimestamp(a + offsetSeconds)}${dash}${formatTimestamp(b + offsetSeconds)}${close}`;
    },
  );

  out = out.replace(BRACKETED, (match, open: string, ts: string, close: string) => {
    const seconds = parseTimestamp(ts);
    return seconds === null ? match : `${open}${formatTimestamp(seconds + offsetSeconds)}${close}`;
  });

  out = out.replace(LINE_LEADING, (match, prefix: string, ts: string, offset: number) => {
    const rest = out.slice(offset + match.length);
    if (FOLLOWED_BY_MERIDIEM.test(rest)) return match;
    const seconds = parseTimestamp(ts);
    return seconds === null ? match : `${prefix}${formatTimestamp(seconds + offsetSeconds)}`;
  });

  return out;
}

/** Offset of a 1-based part index, given the configured segment length. */
export function partOffsetSeconds(partNum: number, segmentSeconds: number): number {
  return Math.max(0, (partNum - 1) * segmentSeconds);
}

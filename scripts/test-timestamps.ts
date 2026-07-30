/**
 * Regression test for timestamp rebasing (src/utils/timestamps.ts).
 *
 * Each part is uploaded as its own video, so Gemini numbers every segment from
 * 00:00 and the offset is added here afterwards. A timestamp that silently
 * fails to shift is the worst outcome: it still looks like a valid timestamp
 * and points at the wrong place in a two-hour recording.
 *
 * Covers the shapes the prompt actually elicits — timestamped headings, inline
 * markers, and ranges like [00:00 - 00:28], which the original bracket pattern
 * matched at neither end — plus the things that must NOT move: clock times,
 * ratios, and markdown link targets.
 *
 * Pure string manipulation: no browser, no network.
 *
 *   npm run test:timestamps
 */

import { shiftTimestamps } from "../src/utils/timestamps.js";

const input = `### [00:41] Dispatch and the ready list
- **Ready list** — the queue of tasks eligible to run.
- [01:05] "The dispatcher never decides which task" — lecturer.
- [04:10] Nothing on screen until [09:30].
## [1:02:03] Late heading
- Lecture starts at 9:00 AM sharp.
- The ratio was 3:1 in favour.
- 02:15 — bare leading timestamp
- **Details**: [00:00 - 00:28] slide one, no audio.
- Span with en dash [01:00–01:29] and hours [1:00:00 - 1:00:30].
- Markdown [a link](https://example.com/9:99) must survive.
`;
const out = shiftTimestamps(input, 1800); // part 3 of a 15-min split
console.log(out);
const checks: Array<[string, boolean]> = [
  ["heading timestamp shifted", out.includes("### [30:41]")],
  ["inline bullet shifted", out.includes("[31:05]")],
  ["two separate brackets shifted", out.includes("[34:10]") && out.includes("[39:30]")],
  ["hour form shifted", out.includes("[1:32:03]")],
  ["clock time untouched", out.includes("9:00 AM")],
  ["ratio untouched", out.includes("3:1 in favour")],
  ["bare leading shifted", out.includes("32:15 —")],
  ["range both ends shifted", out.includes("[30:00 - 30:28]")],
  ["en-dash range shifted", out.includes("[31:00–31:29]")],
  ["hour range shifted", out.includes("[1:30:00 - 1:30:30]")],
  ["markdown link untouched", out.includes("[a link](https://example.com/9:99)")],
];

// The other direction, added for the caption offset: notes are written against
// the downloaded file, and a recording Panopto trimmed at the front has a
// transcript whose clock starts later. Taking the notes *down* into that clock
// is what lets the two be read together — see buildHighlights.
const back = shiftTimestamps(input, -120);
checks.push(
  ["a negative shift moves a heading back", back.includes("### [00:00]")],
  ["and an inline marker with it", back.includes("[00:00]") && back.includes("[02:10]")],
  ["an hour form comes back too", back.includes("[1:00:03]")],
  ["ranges move at both ends", back.includes("[00:00 - 00:00]") || back.includes("[00:00 - 00:28]")],
  // Anything that would land before the transcript starts clamps rather than
  // going negative: that speech genuinely isn't in the transcript.
  ["nothing goes negative", !/-\d?\d:\d\d/.test(back)],
  ["a clock time is still not a timestamp", back.includes("9:00 AM")],
);
let bad = 0;
for (const [n, ok] of checks) { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); }
process.exit(bad === 0 ? 0 : 1);

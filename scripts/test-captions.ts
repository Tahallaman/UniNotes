/**
 * Regression test for the caption offset (src/panopto/captions.ts).
 *
 * Panopto sometimes trims the front of a recording for playback and cuts the
 * transcript to the trimmed version, while the file you can download is the
 * untrimmed original. shiftVtt is what reconciles the two, and it is worth a
 * test for the same reason timestamp rebasing is: a shift that silently fails
 * still produces a perfectly valid transcript that points at the wrong minute of
 * the lecture, and every note timestamp and highlight span is expressed in these
 * times.
 *
 * Pure string manipulation: no browser, no network.
 *
 *   npm run test:captions
 */

import { shiftVtt, parseVtt } from "../src/panopto/captions.js";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

const vtt = [
  "WEBVTT",
  "",
  "1",
  "00:00:04.000 --> 00:00:09.500",
  "Right, so this is the counterfactual baseline.",
  "",
  "2",
  "00:59:58.250 --> 01:00:03.000",
  "He says the exam is at 10:30 sharp.",
  "",
].join("\n");

const later = shiftVtt(vtt, 12);

check("a cue's start moves", later.includes("00:00:16.000 -->"));
check("and so does its end", later.includes("--> 00:00:21.500"));
check("the header is left alone", later.startsWith("WEBVTT"));
check("cue numbering survives", /\n1\n/.test(later));
check("the words are untouched", later.includes("counterfactual baseline"));

// A timestamp a lecturer said out loud is text, not timing. Only lines carrying
// "-->" are times; anything else that looks like one is somebody's sentence.
check("a time inside a cue's text stays put", later.includes("exam is at 10:30 sharp"));

check("an hour rolls over", later.includes("01:00:10.250 -->"));
check("and carries the hour on the far side", later.includes("--> 01:00:15.000"));

// Zero has to be exactly the identity, not a re-render: every lecture that
// doesn't need this goes through the same function.
check("no offset returns the file untouched", shiftVtt(vtt, 0) === vtt);
check("and neither does a NaN", shiftVtt(vtt, Number.NaN) === vtt);

// The other direction — a transcript that starts *after* the picture — clamps at
// the top of the file rather than going negative, which VTT cannot express.
const earlier = shiftVtt(vtt, -6);
check("shifting past the start clamps to zero", earlier.includes("00:00:00.000 -->"));
// Only the part that fell off the front is lost. A cue straddling the start
// still has most of itself inside the file, and it should still be shown.
check("keeping whatever of the cue is still inside the file", earlier.includes("--> 00:00:03.500"));
// A cue that ends up entirely before the file starts collapses to nothing, which
// is what it is: speech the downloaded recording does not contain.
check("a cue wholly off the front collapses", shiftVtt(vtt, -30).includes("00:00:00.000 --> 00:00:00.000"));

// The two halves have to agree: what the player reads back must be what was
// asked for, or the subtitles and the note timestamps drift apart by the error.
const before = parseVtt(vtt);
const after = parseVtt(shiftVtt(vtt, 7.5));
check("parsed cues come back shifted by exactly the offset", after[0].start - before[0].start === 7.5);
check("and so do their ends", Math.abs(after[1].end - before[1].end - 7.5) < 0.001);
check("with the same number of cues", after.length === before.length);

// SRT's decimal comma reaches VTT occasionally; cueTime accepts it, so the shift
// has to as well rather than leaving that cue where it was.
const comma = "WEBVTT\n\n1\n00:00:04,000 --> 00:00:09,500\nA line.\n";
check("a comma decimal shifts too", shiftVtt(comma, 6).includes("00:00:10.000 --> 00:00:15.500"));

let bad = 0;
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

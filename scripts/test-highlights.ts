/**
 * Regression test for the two halves of Highlights that aren't the model.
 *
 * `clean` turns whatever the model said into spans that can be played, and
 * `trim` holds a reel to the length it was asked for. Both fail quietly if they
 * fail at all — a span that opens two seconds late still plays, a Skim that came
 * back at a third of the lecture still produces a reel — so the failures worth
 * guarding against are the ones you would not notice while watching.
 *
 * Pure: no filesystem, no network, no model. Every config value the two
 * functions read is passed in.
 *
 *   npm run test:highlights
 */

import { blocks, clean, gaps, plan, readJsonArray, trim, type Cue, type Segment } from "../src/gui/highlights.js";

const checks: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
  checks.push([name, ok]);
}

const cfg = { leadInSeconds: 3, minSegmentSeconds: 30 };

/** A transcript with a cue every 5 seconds, so boundaries are predictable. */
const cues: Cue[] = Array.from({ length: 240 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 5,
  text: `line ${i}`,
}));

// ── clean: boundaries land on real cues ───────────────────────────────────

const snapped = clean(
  [{ start: "02:02", end: "03:01", weight: 4, why: "mid-cue on both ends" }],
  cues,
  1200,
  cfg,
);
// 122 − 3 of lead-in is 119, which sits inside the cue starting at 115.
check("a start snaps back to the cue covering it", snapped[0]?.start === 115);
// 181 sits inside the cue running 180–185, and a span closes on a finished cue.
check("an end snaps forward to the end of its cue", snapped[0]?.end === 185);

const noLead = clean(
  [{ start: "02:00", end: "03:00", weight: 4, why: "on a boundary already" }],
  cues,
  1200,
  { leadInSeconds: 0, minSegmentSeconds: 30 },
);
check("no lead-in leaves an exact boundary alone", noLead[0]?.start === 120);

// ── clean: what gets thrown away ──────────────────────────────────────────

check(
  "a span shorter than the floor is dropped",
  clean([{ start: 100, end: 115, weight: 5, why: "twelve seconds of nothing" }], cues, 1200, cfg)
    .length === 0,
);
check(
  "a span with no reason is dropped",
  clean([{ start: 100, end: 200, weight: 5, why: "  " }], cues, 1200, cfg).length === 0,
);
check(
  "a backwards span is dropped",
  clean([{ start: 300, end: 200, weight: 5, why: "ends before it starts" }], cues, 1200, cfg)
    .length === 0,
);
check(
  "an unparseable time is dropped",
  clean([{ start: "soon", end: "later", weight: 5, why: "no" }], cues, 1200, cfg).length === 0,
);

// Both forms, because a model asked for MM:SS will sometimes answer in seconds.
const bothForms = clean(
  [
    { start: 100, end: 200, weight: 4, why: "seconds" },
    { start: "05:00", end: "06:00", weight: 4, why: "clock" },
  ],
  cues,
  1200,
  cfg,
);
check("seconds and MM:SS are both accepted", bothForms.length === 2);

// ── clean: order, overlap and bounds ──────────────────────────────────────

const jumbled = clean(
  [
    { start: 600, end: 700, weight: 3, why: "second" },
    { start: 100, end: 200, weight: 3, why: "first" },
  ],
  cues,
  1200,
  cfg,
);
check("spans come back in time order", jumbled[0]?.why === "first" && jumbled[1]?.why === "second");

const overlapping = clean(
  [
    { start: 100, end: 300, weight: 2, why: "the weaker one" },
    { start: 200, end: 400, weight: 5, why: "the stronger one" },
  ],
  cues,
  1200,
  cfg,
);
check("an overlap keeps only one span", overlapping.length === 1);
check("and it keeps the stronger of the two", overlapping[0]?.why === "the stronger one");

const overrun = clean(
  [{ start: 1100, end: 5000, weight: 5, why: "runs off the end of the recording" }],
  cues,
  1200,
  cfg,
);
check("a span is clamped to the recording's length", overrun[0]?.end === 1200);

// ── clean: this reel's own ceiling on a span ──────────────────────────────

const capped = clean(
  [{ start: 100, end: 400, weight: 5, why: "far longer than a skim allows" }],
  cues,
  1200,
  { leadInSeconds: 0, minSegmentSeconds: 4, maxSeconds: 20 },
);
check("a span is cut back to the preset's ceiling", (capped[0]?.end ?? 0) - (capped[0]?.start ?? 0) <= 25);
// Cut at a cue rather than at the arithmetic: 100 + 20 is 120, which is where a
// cue happens to end here, so the ceiling and the boundary agree exactly.
check("and the cut lands on a cue boundary", capped[0]?.end === 120);

// Where they don't agree, the nearer boundary of that cue wins. 100 + 18 = 118
// sits in the cue running 115–120, and 120 is nearer than 115.
const cappedOdd = clean(
  [{ start: 100, end: 400, weight: 5, why: "long" }],
  cues,
  1200,
  { leadInSeconds: 0, minSegmentSeconds: 4, maxSeconds: 18 },
);
check("a ceiling mid-cue takes the nearer boundary", cappedOdd[0]?.end === 120);

// And when the limit lands just inside a cue, it rounds back rather than out —
// 100 + 17 = 117 is nearer 115 than 120, so the span ends early instead of over.
const cappedBack = clean(
  [{ start: 100, end: 400, weight: 5, why: "long" }],
  cues,
  1200,
  { leadInSeconds: 0, minSegmentSeconds: 4, maxSeconds: 17 },
);
check("a ceiling just inside a cue rounds back to its start", cappedBack[0]?.end === 115);
check("which keeps the span under the ceiling", (cappedBack[0]?.end ?? 0) - 100 <= 17);

// ── clean: the run-out at the end of a span ───────────────────────────────
//
// A cue's end is where the transcriber stopped, not where the speaker did, so
// each span gets a beat past its boundary. The whole point is that it survives
// everything else clean() does — the cap, and the pass that resolves overlaps by
// deleting a span.

const tailCfg = { leadInSeconds: 0, minSegmentSeconds: 4, tailSeconds: 2 };
const tailed = clean([{ start: 100, end: 148, weight: 4, why: "one span" }], cues, 1200, tailCfg);
check("a span runs on past its cue boundary", tailed[0]?.end === 152);
check("and its start is untouched", tailed[0]?.start === 100);

const noTail = clean([{ start: 100, end: 148, weight: 4, why: "one span" }], cues, 1200,
  { leadInSeconds: 0, minSegmentSeconds: 4 });
check("no run-out configured is exactly as before", noTail[0]?.end === 150);

// 8s of run-out against a 5s gap: it stops where the next span starts rather
// than reaching into it. Both spans survive — an overlap here would have been
// resolved by deleting one of them.
const crowded = clean(
  [{ start: 100, end: 148, weight: 4, why: "first" }, { start: 157, end: 198, weight: 4, why: "second" }],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4, tailSeconds: 8 },
);
check("a run-out stops where the next span starts", crowded[0]?.end === 155);
check("so it never overlaps its neighbour", (crowded[0]?.end ?? 0) <= (crowded[1]?.start ?? 0));
check("and no span is lost to it", crowded.length === 2);
// 198 snaps out to the cue ending at 200, and nothing follows it, so it takes
// the whole 8 seconds.
check("the last span still gets its full run-out", crowded[1]?.end === 208);

// Spans that already abut have nothing to add: playback is continuous across
// that join, so nothing was being clipped there in the first place.
const abutting = clean(
  [{ start: 100, end: 148, weight: 4, why: "first" }, { start: 151, end: 198, weight: 4, why: "second" }],
  cues, 1200, tailCfg,
);
check("nothing is added where the next span follows immediately", abutting[0]?.end === 150);

const atEnd = clean([{ start: 1180, end: 1195, weight: 4, why: "the last one" }], cues, 1200,
  { leadInSeconds: 0, minSegmentSeconds: 4, tailSeconds: 8 });
check("a run-out cannot pass the end of the recording", atEnd[0]?.end === 1200);

// Deliberately after the cap: a span already at its preset's ceiling is the one
// most likely to be cut mid-sentence, so capping the run-out away would take it
// off exactly where it is needed.
const cappedTail = clean(
  [{ start: 100, end: 400, weight: 5, why: "long" }],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4, maxSeconds: 20, tailSeconds: 2 },
);
check("the run-out survives the preset's ceiling", cappedTail[0]?.end === 122);

// ── trim: holding a reel to the time it was asked for ─────────────────────

const spans = (list: Array<[number, number, number]>): Segment[] =>
  list.map(([start, length, weight]) => ({ start, end: start + length, weight, why: `w${weight}` }));

const total = (list: Segment[]) => list.reduce((sum, s) => sum + (s.end - s.start), 0);

// 5 × 60s = 300s of material against a 180s budget.
const over = spans([[0, 60, 5], [100, 60, 1], [200, 60, 4], [300, 60, 2], [400, 60, 3]]);
const fitted = trim(over, 180);
check("an over-long reel is cut to the budget", total(fitted) <= 180);
check("the weakest spans are the ones dropped", fitted.every((s) => s.weight >= 3));
check("and the strongest survive", fitted.some((s) => s.weight === 5));
check("what's left is still in time order", fitted.map((s) => s.start).join() === "0,200,400");

// Undershooting is left alone. A lecture with two minutes worth keeping gives a
// two-minute reel; padding it out to reach a percentage would be inventing value.
const under = spans([[0, 30, 5], [100, 30, 4]]);
check("a short reel is not padded", trim(under, 600).length === 2);
check("and is returned untouched", total(trim(under, 600)) === 60);

// The cut count is the thing being asked for, so trimming may not undo it: a
// reel cut from 56 spans to 45 to save ninety seconds is worse in the only
// dimension anyone measured.
const many = spans(Array.from({ length: 20 }, (_, i) => [i * 100, 60, 3] as [number, number, number]));
check("trimming stops at the floor", trim(many, 180, 0, 0, 15).length === 15);
check("and still trims down to it", trim(many, 180, 0, 0, 5).length === 5);

// Among equals, the longest goes first: dropping one 60-second span beats
// dropping four 15-second ones, because the cut count is what makes a reel.
const equals = spans([[0, 60, 3], [100, 15, 3], [200, 15, 3], [300, 15, 3], [400, 15, 3]]);
const kept = trim(equals, 60);
check("among equal scores the longest is dropped first", kept.every((s) => s.end - s.start === 15));
check("which keeps the cut count up", kept.length === 4);

// ── gaps: what the second pass is told to go and fix ──────────────────────

// An hour of lecture, covered every two minutes: no holes.
const dense = spans(Array.from({ length: 25 }, (_, i) => [180 + i * 120, 20, 4] as [number, number, number]));
check("a well-covered reel has no gaps", gaps(dense, 3300, 180).length === 0);

// The same, with the middle third missing.
const holed = dense.filter((s) => s.start < 1200 || s.start > 2000);
const found = gaps(holed, 3300, 180);
check("a hole in the middle is found", found.length === 1);
// From the end of the last cut before it to the start of the next one after.
check("and it is reported with its real bounds", found[0][0] === 1160 && found[0][1] === 2100);

// The head and tail are exempt: lectures open with arrival and admin and close
// with "any questions", and a reel that skips both is right to.
// Four minutes of arrival and admin before the first cut, then covered
// throughout: the exemption is what stops that reading as a hole.
const lateStart = spans(Array.from({ length: 24 }, (_, i) => [240 + i * 120, 20, 4] as [number, number, number]));
check("the opening minutes are not a gap", gaps(lateStart, 3100, 180).length === 0);
check(
  "nor are the closing ones",
  gaps(spans([[130, 20, 4]]), 300, 180).length === 0,
);
check("but a long tail is", gaps(spans([[130, 20, 4]]), 900, 180).length === 1);
check("switching the check off finds nothing", gaps(holed, 3300, 0).length === 0);
check("and an empty reel reports no gaps rather than one big one", gaps([], 3300, 180).length === 0);

// ── trim: coverage outranks the budget ────────────────────────────────────

// Five cuts spread across an hour, the middle one weakest. Trimming to half the
// material would drop it — except that doing so opens a twenty-minute hole.
const spread = spans([[200, 60, 5], [800, 60, 4], [1400, 60, 1], [2000, 60, 4], [2600, 60, 5]]);
check(
  "a weak span is dropped when nothing depends on it",
  trim(spread, 240).length === 4,
);
check(
  "but kept when losing it would tear a hole",
  trim(spread, 240, 600, 3000).length === 5,
);
// And the budget still bites where it can do so safely.
const clustered = spans([[200, 60, 5], [280, 60, 1], [360, 60, 4], [440, 60, 2], [520, 60, 5]]);
check(
  "a dense run is still trimmed",
  trim(clustered, 180, 600, 700).length === 3,
);

// ── reading back what the model returned ──────────────────────────────────

check(
  "a plain array is read",
  readJsonArray('[{"start":"1:00","end":"1:20","weight":4,"why":"a"}]').length === 1,
);
check(
  "a fenced array is read",
  readJsonArray('```json\n[{"start":"1:00","end":"1:20","weight":4,"why":"a"}]\n```').length === 1,
);
check(
  "preamble before the array is ignored",
  readJsonArray('Here you go:\n[{"start":"1:00","end":"1:20","weight":4,"why":"a"}]').length === 1,
);
// The one that matters: a long lecture can exhaust the token budget mid-array,
// and forty good spans followed by half of a forty-first is still forty spans.
check(
  "an answer cut off mid-array salvages what completed",
  readJsonArray('[{"start":"1:00","end":"1:20","weight":4,"why":"a"},'
    + '{"start":"2:00","end":"2:20","weight":4,"why":"b"},{"start":"3:00","end":"3:2').length === 2,
);
let unreadable = false;
try { readJsonArray("I'm sorry, I can't do that."); } catch { unreadable = true; }
check("and a reply with no list at all is an error", unreadable);

// ── plan: how many cuts to ask for, and how long ──────────────────────────

const hl = { share: 25, minSeconds: 8, maxSeconds: 30, aimSeconds: 15, minSpans: 50 };

// A 44-minute lecture: 25% is 11 minutes, which at 15s a cut is only 44 of them.
const floored = plan(hl, 2632);
check("the floor lifts the count when the arithmetic falls short", floored.spans === 50);
check("and the cut length is derived back from it", floored.aimSeconds === 13);
check("so the total is unchanged", Math.abs(floored.spans * floored.aimSeconds - floored.target) < 60);

// A 90-minute lecture already clears the floor on its own.
const long = plan(hl, 5400);
check("a long lecture asks for more than the floor", long.spans === 90);
check("and keeps its intended cut length", long.aimSeconds === 15);

// The floor may not turn one preset into another: a Deep cut is clamped at its
// own minimum even when the count would imply something shorter.
const deep = { share: 45, minSeconds: 12, maxSeconds: 50, aimSeconds: 25, minSpans: 60 };
const shortLecture = plan(deep, 900);
check("the preset's own floor still binds", shortLecture.aimSeconds === 12);
check("even though that overruns the share", shortLecture.spans * shortLecture.aimSeconds > shortLecture.target);

// The point of the count being per-preset: on the same lecture the three come
// out different lengths, rather than all landing where fifty watchable cuts do.
const skim = { share: 12, minSeconds: 6, maxSeconds: 16, aimSeconds: 10, minSpans: 35 };
const short = plan(skim, 2632);
const thorough = plan(deep, 2632);
check("a lower count is what makes Skim genuinely shorter", short.spans === 35);
check("without shortening its cuts below what a cue can say", short.aimSeconds >= skim.minSeconds);
check(
  "and Deep runs several times longer on the same lecture",
  thorough.spans * thorough.aimSeconds > short.spans * short.aimSeconds * 3,
);

// ── The two clocks ────────────────────────────────────────────────────────────

// A lecture Panopto trimmed at the front: the transcript's 00:10 is the
// recording's 04:00. The model is shown the recording's clock — the notes' — and
// what it returns is brought back to the transcript's before it is snapped and
// saved, so a reel survives the offset being corrected later.
const twoClocks: Cue[] = [
  { start: 10, end: 20, text: "first" },
  { start: 20, end: 30, text: "second" },
];
const OFF = 230;

check("with no offset the transcript reads as written", blocks(twoClocks, 30).startsWith("[00:10]"));
check("with one, it is shown in the recording's clock", blocks(twoClocks, 30, OFF).startsWith("[04:00]"));
check("and the words are untouched by it", blocks(twoClocks, 30, OFF).includes("first second"));

// The return leg. What the model gives back is in the clock it was shown, so a
// span it calls 04:00 is the cue at 00:10 — and that is what has to be stored,
// because that is what the cues say and what survives a corrected offset.
const shown = 240; // 04:00 in the recording's clock
check(
  "a returned time comes back to the transcript's clock",
  clean(
    [{ start: shown, end: shown + 20, weight: 5, why: "the point" }].map((r) => ({
      ...r, start: r.start - OFF, end: r.end - OFF,
    })),
    twoClocks,
    30,
    { leadInSeconds: 0, minSegmentSeconds: 4 },
  )[0]?.start === 10,
);
// The failure this guards against: forgetting the return leg stores 240 against a
// transcript that ends at 30, which the lecture-length clamp then flattens.
check(
  "and forgetting to convert it would not survive the clamp",
  clean(
    [{ start: shown, end: shown + 20, weight: 5, why: "the point" }],
    twoClocks,
    30,
    { leadInSeconds: 0, minSegmentSeconds: 4 },
  ).every((s) => s.start !== 10),
);

let bad = 0;
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

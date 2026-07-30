/**
 * Regression test for the part of Highlights that isn't the model.
 *
 * `clean` turns whatever the model said into spans that can be played: snapped
 * to real cue boundaries, finished on a sentence, joined where nothing sits
 * between them. It fails quietly if it fails at all — a span that opens two
 * seconds late still plays, one that ends mid-word still plays — so the failures
 * worth guarding against are the ones you would not notice while watching.
 *
 * There is no longer a pass that drops spans to reach a target length, and no
 * score to order one by: what the model returns is the reel.
 *
 * Pure: no filesystem, no network, no model. Every config value the two
 * functions read is passed in.
 *
 *   npm run test:highlights
 */

import { blocks, clean, gaps, plan, readJsonArray, type Cue, type Segment } from "../src/gui/highlights.js";

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
  [{ start: "02:02", end: "03:01", why: "mid-cue on both ends" }],
  cues,
  1200,
  cfg,
);
// 122 − 3 of lead-in is 119, which sits inside the cue starting at 115.
check("a start snaps back to the cue covering it", snapped[0]?.start === 115);
// 181 sits inside the cue running 180–185, and a span closes on a finished cue.
check("an end snaps forward to the end of its cue", snapped[0]?.end === 185);

const noLead = clean(
  [{ start: "02:00", end: "03:00", why: "on a boundary already" }],
  cues,
  1200,
  { leadInSeconds: 0, minSegmentSeconds: 30 },
);
check("no lead-in leaves an exact boundary alone", noLead[0]?.start === 120);

// ── clean: what gets thrown away ──────────────────────────────────────────

check(
  "a span shorter than the floor is dropped",
  clean([{ start: 100, end: 115, why: "twelve seconds of nothing" }], cues, 1200, cfg)
    .length === 0,
);
check(
  "a span with no reason is dropped",
  clean([{ start: 100, end: 200, why: "  " }], cues, 1200, cfg).length === 0,
);
check(
  "a backwards span is dropped",
  clean([{ start: 300, end: 200, why: "ends before it starts" }], cues, 1200, cfg)
    .length === 0,
);
check(
  "an unparseable time is dropped",
  clean([{ start: "soon", end: "later", why: "no" }], cues, 1200, cfg).length === 0,
);

// Both forms, because a model asked for MM:SS will sometimes answer in seconds.
const bothForms = clean(
  [
    { start: 100, end: 200, why: "seconds" },
    { start: "05:00", end: "06:00", why: "clock" },
  ],
  cues,
  1200,
  cfg,
);
check("seconds and MM:SS are both accepted", bothForms.length === 2);

// ── clean: order, overlap and bounds ──────────────────────────────────────

const jumbled = clean(
  [
    { start: 600, end: 700, why: "second" },
    { start: 100, end: 200, why: "first" },
  ],
  cues,
  1200,
  cfg,
);
check("spans come back in time order", jumbled[0]?.why === "first" && jumbled[1]?.why === "second");

// Two spans over the same seconds are describing one stretch of lecture, so
// they become one covering both. This used to resolve by deleting the
// lower-scored span, which threw away material the model had chosen in order to
// break a tie — and was the last thing the scores were used for.
const overlapping = clean(
  [
    { start: 100, end: 300, why: "the first" },
    { start: 200, end: 400, why: "the second" },
  ],
  cues,
  1200,
  cfg,
);
check("an overlap becomes one span", overlapping.length === 1);
// 95 rather than 100: this fixture carries a 3-second lead-in, so the start
// snaps back to the cue covering 97.
check("reaching from the first start to the second end", overlapping[0]?.start === 95 && overlapping[0]?.end === 400);
check("and neither reason is lost", overlapping[0]?.why === "the first; the second");

const overrun = clean(
  [{ start: 1100, end: 5000, why: "runs off the end of the recording" }],
  cues,
  1200,
  cfg,
);
check("a span is clamped to the recording's length", overrun[0]?.end === 1200);

// ── clean: the backstop, which is not a shape ─────────────────────────────
//
// Each preset's own longest-cut figure is asked for in the brief and enforced
// nowhere: cutting a span back to a number overruled the model on exactly the
// spans where it mattered, because a long span is long when something is still
// being explained. What is left only catches a runaway.

const runaway = clean(
  [{ start: 100, end: 900, why: "a span that swallowed the lecture" }],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4, maxSegmentSeconds: 20 },
);
check("a runaway span is caught by the backstop", runaway[0]?.end === 120);

const uncapped = clean(
  [{ start: 100, end: 400, why: "far longer than a skim would ask for" }],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4 },
);
check("but nothing else caps a span any more", uncapped[0]?.end === 400);

// ── clean: finishing the sentence ─────────────────────────────────────────
//
// A cue boundary is a breath. These cues are punctuated the way a real
// auto-transcript's are, so the sentence's own end can be found.

const spoken: Cue[] = [
  { start: 0, end: 5, text: "This is the first sentence." },
  { start: 5, end: 10, text: "And this one runs on" },
  { start: 10, end: 15, text: "past the boundary before it stops." },
  { start: 15, end: 20, text: "A new one begins here." },
];
const sentenceCfg = { leadInSeconds: 0, minSegmentSeconds: 1, finishSentenceSeconds: 12 };

const midClause = clean([{ start: 5, end: 8, why: "ends mid-clause" }], spoken, 100, sentenceCfg);
check("a span ending mid-sentence runs on to the full stop", midClause[0]?.end === 15);

const already = clean([{ start: 0, end: 3, why: "already ends on one" }], spoken, 100, sentenceCfg);
check("one that already ends on a sentence stays put", already[0]?.end === 5);

const tooFar = clean([{ start: 5, end: 8, why: "ends mid-clause" }], spoken, 100,
  { leadInSeconds: 0, minSegmentSeconds: 1, finishSentenceSeconds: 2 });
check("but it will not wait forever for one", tooFar[0]?.end === 10);

const noFinish = clean([{ start: 5, end: 8, why: "ends mid-clause" }], spoken, 100,
  { leadInSeconds: 0, minSegmentSeconds: 1 });
check("and switched off it is exactly as before", noFinish[0]?.end === 10);

// ── clean: spans with nothing between them are one span ───────────────────

const split = clean(
  [
    { start: 100, end: 148, why: "says what a baseline is" },
    { start: 151, end: 178, why: "says what happens if you get it wrong" },
    { start: 500, end: 548, why: "somewhere else entirely" },
  ],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4, joinGapSeconds: 3 },
);
check("a passage split into two comes back as one", split.length === 2);
check("covering both of them", split[0]?.start === 100 && split[0]?.end === 180);
check("keeping both reasons", /baseline is; .*get it wrong/.test(split[0]?.why ?? ""));
check("while a genuine cut is left alone", split[1]?.start === 500);

// The join is what a viewer can hear, not what the model wrote: spans far
// enough apart that real lecture is dropped between them stay separate.
const apart = clean(
  [
    { start: 100, end: 148, why: "first" },
    { start: 200, end: 248, why: "second" },
  ],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4, joinGapSeconds: 3 },
);
check("two moments with a gap between them stay two spans", apart.length === 2);

// ── clean: a range handed back in one field ───────────────────────────────
//
// The transcript is labelled [12:30–12:41] now, so sooner or later a model
// echoes a whole label into a single field. Which half is meant depends on which
// field it is, and reading an end as its range's start is exactly the early cut
// this change exists to stop.

const echoed = clean(
  [{ start: "01:40–01:45", end: "03:15–03:20", why: "a range in both fields" }],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4 },
);
check("a range in the start field reads as its start", echoed[0]?.start === 100);
check("and a range in the end field reads as its end", echoed[0]?.end === 200);

// ── clean: the run-out at the end of a span ───────────────────────────────
//
// A cue's end is where the transcriber stopped, not where the speaker did, so
// each span gets a beat past its boundary. The whole point is that it survives
// everything else clean() does — the cap, and the pass that resolves overlaps by
// deleting a span.

const tailCfg = { leadInSeconds: 0, minSegmentSeconds: 4, tailSeconds: 2 };
const tailed = clean([{ start: 100, end: 148, why: "one span" }], cues, 1200, tailCfg);
check("a span runs on past its cue boundary", tailed[0]?.end === 152);
check("and its start is untouched", tailed[0]?.start === 100);

const noTail = clean([{ start: 100, end: 148, why: "one span" }], cues, 1200,
  { leadInSeconds: 0, minSegmentSeconds: 4 });
check("no run-out configured is exactly as before", noTail[0]?.end === 150);

// 8s of run-out against a 5s gap: it stops where the next span starts rather
// than reaching into it. Both spans survive — an overlap here would have been
// resolved by deleting one of them.
const crowded = clean(
  [{ start: 100, end: 148, why: "first" }, { start: 157, end: 198, why: "second" }],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4, tailSeconds: 8 },
);
check("a run-out stops where the next span starts", crowded[0]?.end === 155);
check("so it never overlaps its neighbour", (crowded[0]?.end ?? 0) <= (crowded[1]?.start ?? 0));
check("and no span is lost to it", crowded.length === 2);
// 198 snaps out to the cue ending at 200, and nothing follows it, so it takes
// the whole 8 seconds.
check("the last span still gets its full run-out", crowded[1]?.end === 208);

// Spans that touch are joined before the run-out is applied, so the beat is
// added to the end of the joined span rather than inside it — where it would
// have been silently swallowed anyway.
const abutting = clean(
  [{ start: 100, end: 148, why: "first" }, { start: 151, end: 198, why: "second" }],
  cues, 1200, tailCfg,
);
check("touching spans are joined, not padded apart", abutting.length === 1);
check("and the run-out lands on the end of the whole thing", abutting[0]?.end === 202);

const atEnd = clean([{ start: 1180, end: 1195, why: "the last one" }], cues, 1200,
  { leadInSeconds: 0, minSegmentSeconds: 4, tailSeconds: 8 });
check("a run-out cannot pass the end of the recording", atEnd[0]?.end === 1200);

// The backstop is applied before the run-out, so a span held back by it still
// gets its beat — that span is the one most likely to have been cut mid-word.
const cappedTail = clean(
  [{ start: 100, end: 900, why: "long" }],
  cues, 1200, { leadInSeconds: 0, minSegmentSeconds: 4, maxSegmentSeconds: 20, tailSeconds: 2 },
);
check("the run-out survives the backstop", cappedTail[0]?.end === 122);

// A span, for the coverage checks below. There is no score any more: what the
// model returns is the reel, so there is nothing to rank and nothing to drop.
const spans = (list: Array<[number, number]>): Segment[] =>
  list.map(([start, length]) => ({ start, end: start + length, why: `span at ${start}` }));

// ── gaps: what the second pass is told to go and fix ──────────────────────

// An hour of lecture, covered every two minutes: no holes.
const dense = spans(Array.from({ length: 25 }, (_, i) => [180 + i * 120, 20] as [number, number]));
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
const lateStart = spans(Array.from({ length: 24 }, (_, i) => [240 + i * 120, 20] as [number, number]));
check("the opening minutes are not a gap", gaps(lateStart, 3100, 180).length === 0);
check(
  "nor are the closing ones",
  gaps(spans([[130, 20]]), 300, 180).length === 0,
);
check("but a long tail is", gaps(spans([[130, 20]]), 900, 180).length === 1);
check("switching the check off finds nothing", gaps(holed, 3300, 0).length === 0);
check("and an empty reel reports no gaps rather than one big one", gaps([], 3300, 180).length === 0);

// ── reading back what the model returned ──────────────────────────────────

check(
  "a plain array is read",
  readJsonArray('[{"start":"1:00","end":"1:20","why":"a"}]').length === 1,
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

// Both ends of the label, because both are times the model is invited to use —
// an offset applied to only one of them would be a range that spans two clocks.
check("with no offset the transcript reads as written", blocks(twoClocks, 30).startsWith("[00:10–00:30]"));
check("with one, both ends move into the recording's clock", blocks(twoClocks, 30, OFF).startsWith("[04:00–04:20]"));
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

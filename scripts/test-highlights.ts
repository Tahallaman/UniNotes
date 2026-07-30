/**
 * Regression test for the two halves of Highlights that aren't the model.
 *
 * `clean` turns whatever the model said into spans that can be played, and
 * `pick` cuts those candidates down to one preset's worth. Both fail quietly if
 * they fail at all — a span that opens two seconds late still plays, a preset
 * that pads itself out still produces a reel — so the failures worth guarding
 * against are the ones you would not notice while watching.
 *
 * Pure: no filesystem, no network, no model. Every config value the two
 * functions read is passed in.
 *
 *   npm run test:highlights
 */

import { clean, pick, type Cue, type Reel } from "../src/gui/highlights.js";

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

// ── pick: the floor and the share ─────────────────────────────────────────

const presets = {
  skim: { minWeight: 5, share: 10 },
  highlights: { minWeight: 4, share: 25 },
  deep: { minWeight: 3, share: 45 },
};

/** An hour of lecture with one span of each score, two minutes apiece. */
const reel: Reel = {
  madeAt: "2026-08-01T00:00:00.000Z",
  model: "test",
  steer: "",
  lectureSeconds: 3600,
  segments: [1, 2, 3, 4, 5].map((weight, i) => ({
    start: i * 600,
    end: i * 600 + 120,
    weight,
    why: `scored ${weight}`,
  })),
};

check("skim keeps only the fives", pick(reel, "skim", presets).segments.every((s) => s.weight === 5));
check(
  "highlights keeps four and up",
  pick(reel, "highlights", presets).segments.map((s) => s.weight).sort().join() === "4,5",
);
check(
  "deep keeps three and up",
  pick(reel, "deep", presets).segments.map((s) => s.weight).sort().join() === "3,4,5",
);

// The whole point of the floor. A lecture with two minutes' worth in it gives a
// two-minute Deep, not 27 minutes of padding to fill the 45% share.
check("the share is a ceiling, never a quota", pick(reel, "deep", presets).seconds === 360);

const thin: Reel = { ...reel, segments: reel.segments.filter((s) => s.weight <= 2) };
check("a lecture with nothing in it gives an empty reel", pick(thin, "highlights", presets).segments.length === 0);

// ── pick: the budget, and what it does when it bites ──────────────────────

/** Ten minutes of lecture, so a 25% share is 150 seconds. */
const tight: Reel = {
  ...reel,
  lectureSeconds: 600,
  segments: [
    { start: 0, end: 140, weight: 5, why: "the long one" },
    { start: 200, end: 260, weight: 4, why: "a short one" },
    { start: 300, end: 360, weight: 4, why: "another short one" },
  ],
};
const cut = pick(tight, "highlights", presets);
check("the budget is respected", cut.seconds <= 150);
check("the strongest span survives it", cut.segments.some((s) => s.why === "the long one"));
// Best fit, not first fit: the 60-second spans don't fit alongside the 140, and
// stopping at the first one that doesn't fit would have thrown both away.
check("a span that doesn't fit doesn't stop the rest", cut.segments.length === 1);

const roomy = pick({ ...tight, lectureSeconds: 1200 }, "highlights", presets);
check("with room, everything qualifying is taken", roomy.segments.length === 3);
check("and it comes back in time order", roomy.segments[0].start < roomy.segments[2].start);

let bad = 0;
for (const [n, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

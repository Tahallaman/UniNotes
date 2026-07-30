/**
 * Regression test for the context "Explain this" sends (src/gui/explain.ts).
 *
 * The failure this guards against is the quiet one. Nothing throws: the request
 * succeeds, an answer comes back, and it says "the lecture notes don't cover
 * that" about a paragraph the reader is looking at. From the outside that is
 * indistinguishable from the model being unhelpful, so it is exactly the kind of
 * bug that survives a manual check.
 *
 * Two real behaviours are pinned here, both found by using it:
 *
 *   - **Timestamps are not monotonic.** A single back-reference near the end of
 *     a file ("as we saw at [12:30]") made "the last line whose time has been
 *     reached" the bottom of the document, so a question about minute 27 was
 *     answered from minute 40.
 *   - **Sections are not a uniform size.** Sending only the section a moment
 *     falls in sometimes sends four lines, and a model given four lines
 *     correctly reports it hasn't been told enough.
 *
 * Pure functions: no browser, no network, no database, no API calls.
 *
 *   npm run test:explain
 */

import { sliceAround, transcriptWindow, parseVtt, readOverview } from "../src/gui/explain.js";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

// ── A lecture shaped like a real one ─────────────────────────────────────────

/**
 * Padding, so the fixture is the size a lecture's notes actually are.
 *
 * Without it every section is well under MIN_SLICE_CHARS, the slice correctly
 * grows to swallow the whole document, and the tests below pass or fail on
 * whether the file is short rather than on whether the locator works.
 */
const filler = (topic: string) =>
  Array.from(
    { length: 6 },
    (_, i) =>
      `- The lecturer works through ${topic} in some detail, taking a worked example ` +
      `and following it through the datapath one stage at a time (point ${i + 1}).`,
  ).join("\n");

const NOTES = `---
title: "Pipelines"
course: "COMPSYS 730"
panopto_url: "https://example.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=abc"
topics:
  - "Hazards"
  - "Branch prediction"
summary: "A tour of the classic five-stage pipeline and what goes wrong in it."
generated: "2026-07-29T00:00:00.000Z"
---

# Pipelines

## Overview
- [00:30] What a pipeline buys you.
${filler("throughput against latency")}

## Hazards
### Data hazards
- [12:04] A **data hazard** is when one instruction needs a result the previous
  one has not produced yet.
- Forwarding paths solve most of them without a stall.
- The remainder need a bubble.
${filler("the three classes of hazard")}

### Control hazards
- [18:30] A branch is not resolved until well into the pipeline.

## Branch prediction
- [24:10] Two-bit saturating counters.
- They need two wrong guesses in a row before they change their mind, which is
  what makes them survive a loop's closing branch.
${filler("prediction accuracy on real traces")}

## Wrap-up
- [40:00] As we saw back at [12:04], forwarding is the cheap win.
${filler("what to revise")}
`;

// ── Locating a moment ────────────────────────────────────────────────────────

const atHazard = sliceAround(NOTES, 12 * 60 + 30);
check(
  "a moment lands in its own section",
  atHazard.includes("data hazard") && atHazard.includes("Forwarding paths"),
);
check("the heading ancestry comes with it", atHazard.includes("## Hazards"));
check(
  "a late back-reference doesn't drag the slice to the end of the file",
  !atHazard.includes("As we saw back at"),
);

const atBranch = sliceAround(NOTES, 24 * 60 + 30);
check("a later moment lands in its own section", atBranch.includes("saturating counters"));
check("and doesn't reach back two sections", !atBranch.includes("Forwarding paths"));

// The lead-in, with a budget so small the anchor's own section already fills it.
// Without the unconditional step back this returns the branch-prediction section
// alone, which is the case the rule exists for: plenty to read, no idea what it
// follows from.
const tight = sliceAround(NOTES, 24 * 60 + 30, 1);
check("the previous section comes too, however small the budget", tight.includes("Control hazards"));
check("and no more than that", !tight.includes("Wrap-up"));
check("at the top of the document there is nothing to lead in from", sliceAround(NOTES, 0, 1).includes("# Pipelines"));

// ── Growing a thin section ───────────────────────────────────────────────────

const atControl = sliceAround(NOTES, 18 * 60 + 40);
check(
  "a two-line section is grown until it's worth answering from",
  atControl.length > 600 && atControl.includes("Control hazards"),
);

// ── Edges ────────────────────────────────────────────────────────────────────

check("before the first timestamp reads as the top of the document", sliceAround(NOTES, 0).includes("# Pipelines"));
check("past the last timestamp still resolves", sliceAround(NOTES, 99 * 60).includes("As we saw back at"));
check("frontmatter is not sent as notes", !sliceAround(NOTES, 12 * 60 + 30).includes('course: "COMPSYS 730"'));
check("notes with no timestamps give nothing to locate by", sliceAround("# Title\n\nSome prose.\n", 60) === "");

// ── The lecture's own overview ───────────────────────────────────────────────

const overview = readOverview(NOTES);
check("topics come out of the frontmatter", overview.topics.join("|") === "Hazards|Branch prediction");
check("the summary comes out unquoted", overview.summary.startsWith("A tour of the classic"));
check("no frontmatter, no overview", readOverview("# Title\n\nProse.\n").topics.length === 0);
check(
  "a list key that isn't topics doesn't leak into them",
  readOverview('---\nactionItems:\n  - "Read chapter 4"\ntopics:\n  - "Hazards"\n---\n').topics.join("|") === "Hazards",
);
check(
  "an unterminated frontmatter block is ignored rather than half-read",
  readOverview('---\ntopics:\n  - "Hazards"\n').topics.length === 0,
);

// ── Transcript ───────────────────────────────────────────────────────────────

const VTT = `WEBVTT

1
00:00:10.000 --> 00:00:14.000
First line.

2
00:00:20.000 --> 00:00:24.000
Second line.

3
00:01:05.500 --> 00:01:09.000
Third line.

4
00:02:00.000 --> 00:02:04.000
Fourth line.
`;

check("cues parse", parseVtt(VTT).length === 4);

const window = transcriptWindow(VTT, 70, 2);
check("only what has already been said is sent", !window.includes("Fourth line"));
check("and only the last N of it", !window.includes("First line") && window.includes("Second line"));
check("timestamps are attached", window.includes("[01:05]"));
check("nothing spoken yet is an empty window", transcriptWindow(VTT, 5, 6) === "");

// With a caption offset, the whole window moves into the recording's clock — the
// one the notes and the player are in — at both ends. Asked for 70s with the
// transcript running 60s behind the file, the cue spoken at 01:05 has not
// happened yet; asked for 130s, it has, and it is labelled 02:05.
check("an offset holds back a cue the file hasn't reached", !transcriptWindow(VTT, 70, 2, 60).includes("Second line"));
const shifted = transcriptWindow(VTT, 130, 2, 60);
check("and lets it through once it has", shifted.includes("Second line"));
check("labelled in the recording's clock, not the transcript's", shifted.includes("[02:05]") && !shifted.includes("[01:05]"));
check("no offset is exactly as before", transcriptWindow(VTT, 70, 2, 0) === window);

// ── Report ───────────────────────────────────────────────────────────────────

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);

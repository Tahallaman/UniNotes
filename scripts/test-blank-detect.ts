/**
 * Regression test for blank-segment detection (src/utils/blankVideo.ts).
 *
 * Builds its own fixtures with ffmpeg, so it needs no lecture video and nothing
 * from the network. Four shapes, and the two negatives matter most: skipping a
 * real lecture is far worse than paying for an empty one, so the detector
 * requires a segment to be BOTH visually dead AND silent.
 *
 *   npm run test:blank
 */

import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyseBlankness, blankSegmentNote } from "../src/utils/blankVideo.js";
import { CONFIG } from "../config.js";

const execFileAsync = promisify(execFile);
const DIR = path.join(CONFIG.paths.temp, "blank-detect-fixtures");
const D = 30;

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", ...args], { maxBuffer: 20 * 1024 * 1024 });
}

const silent = ["-f", "lavfi", "-i", `anullsrc=r=44100:cl=mono:d=${D}`];
const tone = ["-f", "lavfi", "-i", `sine=frequency=300:duration=${D}`];
const encode = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];

async function buildFixtures(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });

  // A solid non-black colour stands in for a static screen: frozen, but not
  // black, which is the distinction that matters. No drawtext, so this needs no
  // font file and runs the same on every platform.
  const stillScreen = `color=c=0x2b5797:s=640x360:d=${D}`;

  await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=640x360:d=${D}`, ...silent,
    ...encode, path.join(DIR, "black-silent.mp4")]);
  await ffmpeg(["-f", "lavfi", "-i", stillScreen, ...silent,
    ...encode, path.join(DIR, "static-silent.mp4")]);
  await ffmpeg(["-f", "lavfi", "-i", stillScreen, ...tone,
    ...encode, path.join(DIR, "static-audio.mp4")]);
  await ffmpeg(["-f", "lavfi", "-i", `testsrc=s=640x360:d=${D}:r=10`, ...silent,
    ...encode, path.join(DIR, "moving-silent.mp4")]);
}

// [file, expected blank?, why it matters]
const CASES: Array<[string, boolean, string]> = [
  ["black-silent.mp4", true, "dead recording — black and silent"],
  ["static-silent.mp4", true, "idle desktop — frozen, not black, still nothing"],
  ["static-audio.mp4", false, "lecturer talking over one slide — MUST NOT skip"],
  ["moving-silent.mp4", false, "slides advancing, mic failed — MUST NOT skip"],
];

console.log("Building fixtures with ffmpeg...");
await buildFixtures();

let pass = 0;
let fail = 0;
for (const [file, expected, why] of CASES) {
  const result = await analyseBlankness(path.join(DIR, file), D);
  const ok = result.blank === expected;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${file.padEnd(20)} blank=${String(result.blank).padEnd(5)} ` +
      `expect=${String(expected).padEnd(5)} ${why}`,
  );
  if (!ok) console.log(`      dead=${result.deadFraction} silent=${result.silentFraction} :: ${result.summary}`);
}

// The placeholder must carry rebased timestamps, or a skipped segment breaks
// the lecture's timeline.
const note = blankSegmentNote(1800, 900);
const noteOk = note.includes("[30:00") && note.includes("45:00");
noteOk ? pass++ : fail++;
console.log(`${noteOk ? "PASS" : "FAIL"}  ${"placeholder timestamps".padEnd(20)} ${note.split("\n")[0]}`);

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

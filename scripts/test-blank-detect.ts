/**
 * Regression test for blank-segment detection (src/utils/blankVideo.ts).
 *
 * Builds its own fixtures with ffmpeg, so it needs no lecture video and nothing
 * from the network. Six shapes, and the negatives matter most: skipping a real
 * lecture is far worse than paying for an empty one, so the detector requires a
 * segment to be BOTH visually dead AND free of speech.
 *
 * static-roomtone and static-quiet-speech are the pair to keep an eye on. They
 * differ only in level and sit either side of CONFIG.blankDetection.speechFloorDb;
 * moving that setting is what breaks one of them.
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
/** Longer than one audio chunk, so the contiguous scan is genuinely exercised. */
const D = 120;
/** Where the late-start fixture's speech begins — 87% in, mirroring 13:00 of 15:00. */
const LATE_START = 104;

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", ...args], { maxBuffer: 20 * 1024 * 1024 });
}

const silent = ["-f", "lavfi", "-i", `anullsrc=r=44100:cl=mono:d=${D}`];
const tone = ["-f", "lavfi", "-i", `sine=frequency=300:duration=${D}`];
const encode = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];

/**
 * Attenuation applied to the sine, chosen to land each fixture at a real
 * measured level rather than a made-up one.
 *
 * The encoded full-scale sine measures -21dB here, not the -3dB a raw sine
 * would, so the offsets below are relative to that: -26 gives -47dB (the dead
 * COMPSYS 730 recording) and -7 gives -28dB (a recording with real audio).
 * Re-measure the base before changing these — it moves with the encoder.
 */
const atLevel = (db: number) => ["-af", `volume=${db}dB`];

/**
 * Room tone for most of the segment, then someone starts talking near the end.
 *
 * The case that killed the first design: a lecture that begins thirteen minutes
 * into a fifteen-minute segment leaves any average over the whole segment
 * looking dead, and the segment gets discarded along with the real content. The
 * detector must key on the LOUDEST stretch, not the typical one.
 */
const lateStartAudio = [
  "-f", "lavfi", "-i", `sine=frequency=300:duration=${D}`,
  "-af",
  `volume=volume=-26dB:enable='lt(t,${LATE_START})',` +
    `volume=volume=-7dB:enable='gte(t,${LATE_START})'`,
];

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

  // The pair that silencedetect alone cannot separate: both carry a signal above
  // the -50dB silence floor, so both look like "has audio" to it. One is an
  // unmiked room, the other is someone quietly talking.
  await ffmpeg(["-f", "lavfi", "-i", stillScreen, ...tone, ...atLevel(-26),
    ...encode, path.join(DIR, "static-roomtone.mp4")]);
  await ffmpeg(["-f", "lavfi", "-i", stillScreen, ...tone, ...atLevel(-7),
    ...encode, path.join(DIR, "static-quiet-speech.mp4")]);
  await ffmpeg(["-f", "lavfi", "-i", stillScreen, ...lateStartAudio,
    ...encode, path.join(DIR, "static-late-start.mp4")]);
}

// [file, expected blank?, why it matters]
const CASES: Array<[string, boolean, string]> = [
  ["black-silent.mp4", true, "dead recording — black and silent"],
  ["static-silent.mp4", true, "idle desktop — frozen, not black, still nothing"],
  ["static-audio.mp4", false, "lecturer talking over one slide — MUST NOT skip"],
  ["moving-silent.mp4", false, "slides advancing, mic failed — MUST NOT skip"],
  ["static-roomtone.mp4", true, "mic never live — room tone sits ABOVE the silence floor"],
  ["static-quiet-speech.mp4", false, "quiet talker on a static slide — MUST NOT skip"],
  ["static-late-start.mp4", false, "dead until 87% in, then the lecture starts — MUST NOT skip"],
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
  console.log(`      ${result.summary}`);
  if (!ok) console.log(`      dead=${result.deadFraction} loudest=${result.loudestDb} at=${result.loudestAt}`);
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

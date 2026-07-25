/**
 * Regression test for the attachment check in src/gemini/uploader.ts.
 *
 * Guards the failure that produced eight parts of fabricated lecture notes on
 * 2026-07-25: the file never attached, but the send button enabled anyway
 * (Gemini enables it on text alone), so the prompt went out without the video
 * and Gemini answered from the prompt — inventing plausible course content that
 * passed every downstream check and was written to disk.
 *
 * The first two cases are that exact DOM state. They must detect nothing.
 *
 * Runs against synthetic markup via page.setContent, so it needs no Gemini
 * session, contacts no Google service, and is safe to run in a loop.
 *
 *   npm run test:attach
 */

import { chromium } from "playwright";
import { detectAttachment } from "../src/gemini/uploader.js";

const V = "19a08448-e94d-442c-bf55-b48900f75e4c_part3.mp4";
const M = "lecture.raw.md";

// [name, filename the uploader just handed over, page HTML, should detect]
const CASES: Array<[string, string, string, boolean]> = [
  ["empty composer (the failing run)", V, `<input-area-v2><div class="ql-editor">some prompt text</div></input-area-v2>`, false],
  ["send enabled, still no file", V, `<input-area-v2><div class="ql-editor">prompt</div><gem-icon-button aria-disabled="false"><button aria-label="Send message"></button></gem-icon-button></input-area-v2>`, false],
  ["old chip markup", V, `<input-area-v2><button aria-label="Remove file"></button></input-area-v2>`, true],
  ["file-attachment-chip", V, `<input-area-v2><file-attachment-chip></file-attachment-chip></input-area-v2>`, true],
  ["uploader-file-preview", V, `<input-area-v2><uploader-file-preview></uploader-file-preview></input-area-v2>`, true],
  ["unknown chip, filename shown", V, `<input-area-v2><div class="brand-new-thing">${V}</div></input-area-v2>`, true],
  ["filename truncated in middle", V, `<input-area-v2><div>19a08448-e94d-442c-bf5&hellip;part3.mp4</div></input-area-v2>`, true],
  ["pretty path: .md chip", M, `<input-area-v2><div>lecture.raw.md</div></input-area-v2>`, true],
  ["no input-area at all", V, `<div>nothing here</div>`, false],
  ["prompt text only, no chip", V, `<input-area-v2><div class="ql-editor">Write notes for part 3 of 8</div></input-area-v2>`, false],
  ["wrong file attached", V, `<input-area-v2><div>somebody-elses-video.mp4</div></input-area-v2>`, false],
];

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
let pass = 0, fail = 0;
for (const [name, file, html, expected] of CASES) {
  await page.setContent(html);
  const signal = await detectAttachment(page, file);
  const got = signal !== null;
  const ok = got === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} expect=${String(expected).padEnd(5)} got=${String(got).padEnd(5)}${signal ? ` (${signal})` : ""}`);
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

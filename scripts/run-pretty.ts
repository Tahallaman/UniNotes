/**
 * Generate lecture.pretty.md for every lecture.raw.md that doesn't have one yet.
 *
 * Usage: npx tsx scripts/run-pretty.ts
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname!, "..");
const LECTURES_DIR = path.join(ROOT, "Lectures");
const PROMPTS_FILE = path.join(ROOT, "prompts", "pretty-notes.txt");

if (!fs.existsSync(PROMPTS_FILE)) {
  console.error(`Missing prompt file: ${PROMPTS_FILE}`);
  process.exit(1);
}

interface LectureEntry {
  rawPath: string;
  prettyPath: string;
  label: string;
}

// Find all lecture.raw.md missing a sibling lecture.pretty.md
const pending: LectureEntry[] = [];

for (const course of fs.readdirSync(LECTURES_DIR)) {
  const courseDir = path.join(LECTURES_DIR, course);
  if (!fs.statSync(courseDir).isDirectory()) continue;

  for (const lecture of fs.readdirSync(courseDir)) {
    const lectureDir = path.join(courseDir, lecture);
    if (!fs.statSync(lectureDir).isDirectory()) continue;

    const rawPath = path.join(lectureDir, "lecture.raw.md");
    const prettyPath = path.join(lectureDir, "lecture.pretty.md");

    if (fs.existsSync(rawPath) && !fs.existsSync(prettyPath)) {
      pending.push({ rawPath, prettyPath, label: `${course}/${lecture}` });
    }
  }
}

if (pending.length === 0) {
  console.log("All lectures already have pretty notes. Nothing to do.");
  process.exit(0);
}

console.log(`Found ${pending.length} lecture(s) needing pretty notes:\n`);
for (const entry of pending) {
  console.log(`  - ${entry.label}`);
}
console.log();

const RULES = fs.readFileSync(PROMPTS_FILE, "utf-8");

function prettify(entry: LectureEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const rawContent = fs.readFileSync(entry.rawPath, "utf-8");
    const stdinContent = [
      "IMPORTANT: You are running in automated stdout-capture mode.",
      "Output ONLY raw markdown text. Do NOT use any tools (Write, Edit, Bash, etc.).",
      "Do NOT describe what you are doing. Do NOT ask for approval.",
      "Your entire response is read directly from stdout by the calling program.",
      "",
      "FORMATTING RULES:",
      RULES,
      "",
      "---",
      "",
      "LECTURE NOTES TO FORMAT:",
      rawContent,
    ].join("\n");
    console.log(`[START] ${entry.label}`);

    const child = spawn(
      "claude",
      [
        "-p",
        "--allowedTools", "none",
        "Reformat the lecture notes according to the FORMATTING RULES above. Output ONLY the polished markdown, nothing else.",
      ],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], shell: true },
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", (err) => reject(new Error(`spawn failed: ${err.message}`)));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");

      if (code !== 0) {
        reject(new Error(`claude exited ${code} for ${entry.label}: ${stderr.slice(0, 300)}`));
        return;
      }

      if (stdout.trim().length < 100) {
        reject(new Error(`unexpectedly short output for ${entry.label} (${stdout.length} chars)`));
        return;
      }

      fs.writeFileSync(entry.prettyPath, stdout, "utf-8");
      console.log(`[DONE]  ${entry.label} (${stdout.length} chars)`);
      resolve();
    });

    child.stdin.write(stdinContent);
    child.stdin.end();

    // 10 minute timeout per lecture
    setTimeout(() => {
      child.kill();
      reject(new Error(`timeout for ${entry.label}`));
    }, 10 * 60_000);
  });
}

// Process sequentially to avoid hammering the API
let done = 0;
let errors = 0;

for (const entry of pending) {
  try {
    await prettify(entry);
    done++;
  } catch (err) {
    console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    errors++;
  }
}

console.log(`\nComplete: ${done} prettified, ${errors} errors, ${pending.length} total`);

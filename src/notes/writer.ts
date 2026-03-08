import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import type { ParsedActions } from "./parser.js";

interface WriteNotesOptions {
  title: string;
  courseCode: string;
  panoptoUrl?: string;
  geminiChatUrl?: string;
  markdown: string;
  actions: ParsedActions | null;
}

/**
 * Save study notes as lecture.raw.md inside a per-lecture subfolder.
 * Returns the lecture directory path.
 */
export function writeNotes(opts: WriteNotesOptions): string {
  const courseDir = path.join(CONFIG.paths.lectures, opts.courseCode);
  const sanitized = sanitizeFilename(opts.title);

  let lectureDir = path.join(courseDir, sanitized);

  // Handle duplicates — append (1), (2), etc. if folder already has a raw file
  let counter = 1;
  while (
    fs.existsSync(lectureDir) &&
    fs.existsSync(path.join(lectureDir, "lecture.raw.md"))
  ) {
    lectureDir = path.join(courseDir, `${sanitized} (${counter})`);
    counter++;
  }

  fs.mkdirSync(lectureDir, { recursive: true });

  const frontmatter = buildFrontmatter(opts);
  const content = `${frontmatter}\n${opts.markdown}\n`;
  const filePath = path.join(lectureDir, "lecture.raw.md");

  fs.writeFileSync(filePath, content, "utf-8");
  log.info(`Raw notes saved: ${filePath}`);
  return lectureDir;
}

/**
 * Write the pretty-formatted notes into the lecture directory.
 */
export function writePrettyNotes(
  lectureDir: string,
  prettyMarkdown: string,
): void {
  const filePath = path.join(lectureDir, "lecture.pretty.md");
  fs.writeFileSync(filePath, prettyMarkdown, "utf-8");
  log.info(`Pretty notes saved: ${filePath}`);
}

/**
 * Move the original video file into the lecture directory as lecture.<ext>.
 * Falls back to copy+delete if rename fails (e.g. cross-device move).
 */
export function moveLectureVideo(srcPath: string, lectureDir: string): void {
  const ext = path.extname(srcPath) || ".mp4";
  const destPath = path.join(lectureDir, `lecture${ext}`);
  try {
    fs.renameSync(srcPath, destPath);
  } catch {
    fs.copyFileSync(srcPath, destPath);
    fs.unlinkSync(srcPath);
  }
  log.info(`Video moved to: ${destPath}`);
}

function buildFrontmatter(opts: WriteNotesOptions): string {
  const lines = [
    "---",
    `title: "${escapeYaml(opts.title)}"`,
    `course: "${opts.courseCode}"`,
  ];

  if (opts.actions?.lectureDate) {
    lines.push(`date: ${opts.actions.lectureDate}`);
  }

  if (opts.panoptoUrl && !opts.panoptoUrl.startsWith("local://")) {
    lines.push(`panopto_url: "${opts.panoptoUrl}"`);
  }

  if (opts.geminiChatUrl) {
    lines.push(`gemini_chat_url: "${opts.geminiChatUrl}"`);
  }

  if (opts.actions?.keyTopics?.length) {
    lines.push(`topics:`);
    for (const topic of opts.actions.keyTopics) {
      lines.push(`  - "${escapeYaml(topic)}"`);
    }
  }

  if (opts.actions?.summary) {
    lines.push(`summary: "${escapeYaml(opts.actions.summary)}"`);
  }

  lines.push(`generated: "${new Date().toISOString()}"`);
  lines.push("---\n");

  return lines.join("\n");
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, " ");
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

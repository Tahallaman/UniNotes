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

  const lectureDir = path.join(courseDir, sanitized);
  const filePath = path.join(lectureDir, "lecture.raw.md");

  // Reprocessing the same lecture used to fork into "<title> (1)", "(2)", …
  // That reads like caution, but it is the opposite: you end up with two sets of
  // notes for one lecture, differing in content, with nothing to say which is
  // authoritative — and the stale pretty file next to the old raw stays behind
  // to be exported and synced as though it were current.
  //
  // The lecture title *is* the identity here, so a rerun replaces. The previous
  // raw notes are kept alongside as .raw.md.bak, which is enough to diff against
  // when a rerun produces something worse than what it replaced.
  if (fs.existsSync(filePath)) {
    const backup = `${filePath}.bak`;
    fs.copyFileSync(filePath, backup);
    log.info(`Replacing existing notes; previous raw kept at ${path.basename(backup)}`);

    // The old pretty file describes the notes we just replaced. Leaving it would
    // pair new raw notes with a stale prettified copy — and the pretty file is
    // the one that gets exported and synced.
    const stalePretty = path.join(lectureDir, "lecture.pretty.md");
    if (fs.existsSync(stalePretty)) fs.rmSync(stalePretty, { force: true });
  }

  fs.mkdirSync(lectureDir, { recursive: true });

  const frontmatter = buildFrontmatter(opts);
  const content = `${frontmatter}\n${opts.markdown}\n`;

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

/**
 * Process manually downloaded lecture videos through the Gemini pipeline.
 *
 * Convention: drop video files in  Incoming/<CourseCode>/<LectureTitle>.mp4
 * Usage: npx tsx scripts/process-local.ts
 *
 * Each video is processed sequentially, then moved to:
 *   Lectures/<CourseCode>/<LectureTitle>/lecture.<ext>
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG } from "../config.js";
import { log } from "../src/utils/logger.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { getDb, closeDb } from "../src/db/schema.js";
import {
  insertLocalLecture,
  updateStatus,
  setError,
  resetStaleStatuses,
  type LocalLecture,
} from "../src/db/tracker.js";
import { uploadVideoToGemini } from "../src/gemini/uploader.js";
import { submitPromptAndWaitForResponse } from "../src/gemini/prompter.js";
import {
  buildPrompt,
  buildPromptMiddlePart,
  buildPromptFinalPart,
} from "../src/gemini/prompts.js";
import { parseGeminiResponse } from "../src/notes/parser.js";
import { splitVideoIfNeeded } from "../src/utils/videoSplitter.js";
import {
  writeNotes,
  writePrettyNotes,
  moveLectureVideo,
} from "../src/notes/writer.js";
import { prettifyNotes } from "../src/notes/prettifier.js";
import { appendTodoItems } from "../src/todo/manager.js";
import { syncToWorkspace } from "../src/utils/workspaceSync.js";

const retryErrors = process.argv.includes("--retry");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm"]);

interface PendingVideo {
  id: string;
  title: string;
  courseCode: string;
  videoPath: string;
}

function hashPath(p: string): string {
  return createHash("md5").update(p).digest("hex");
}

// ── Collect pending videos ────────────────────────────────────────────────────

const pending: PendingVideo[] = [];

if (!fs.existsSync(CONFIG.paths.incoming)) {
  console.log("Incoming/ directory does not exist yet. Nothing to process.");
  process.exit(0);
}

for (const courseCode of fs.readdirSync(CONFIG.paths.incoming)) {
  const courseDir = path.join(CONFIG.paths.incoming, courseCode);
  if (!fs.statSync(courseDir).isDirectory()) continue;

  for (const filename of fs.readdirSync(courseDir)) {
    const ext = path.extname(filename).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;

    const videoPath = path.join(courseDir, filename);
    const title = path.basename(filename, ext);
    const id = hashPath(videoPath);

    pending.push({ id, title, courseCode, videoPath });
  }
}

if (pending.length === 0) {
  console.log("No videos found in Incoming/. Nothing to process.");
  process.exit(0);
}

console.log(`Found ${pending.length} video(s) to process:\n`);
for (const v of pending) {
  console.log(`  - ${v.courseCode} / ${v.title}`);
}
console.log();

// ── Lock helpers (mirrors main.ts) ───────────────────────────────────────────

function acquireLock(): boolean {
  try {
    const fd = fs.openSync(
      CONFIG.paths.lockFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    fs.writeSync(fd, `${process.pid}`);
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const pid = parseInt(fs.readFileSync(CONFIG.paths.lockFile, "utf-8"), 10);
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        log.warn(`Removing stale lock (PID ${pid} no longer running)`);
        fs.unlinkSync(CONFIG.paths.lockFile);
        return acquireLock();
      }
    } catch {
      return false;
    }
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(CONFIG.paths.lockFile);
  } catch { /* already gone */ }
}

/** Remove split part files (skips the original video). */
function cleanupParts(parts: string[], originalPath: string): void {
  for (const part of parts) {
    if (part === originalPath) continue;
    try { fs.unlinkSync(part); } catch { /* already gone */ }
  }
}

// ── Main processing loop ──────────────────────────────────────────────────────

ensureDirectories();

if (!acquireLock()) {
  console.error("Another UniNotes instance is running (lock file exists). Exiting.");
  process.exit(1);
}

getDb();
resetStaleStatuses();

let done = 0;
let errors = 0;

for (const entry of pending) {
  const localLecture: LocalLecture = {
    id: entry.id,
    title: entry.title,
    courseCode: entry.courseCode,
    videoPath: entry.videoPath,
  };

  const inserted = insertLocalLecture(localLecture, retryErrors);
  if (!inserted) {
    console.log(`[SKIP]  ${entry.courseCode}/${entry.title} (already in DB — use --retry to re-run errors)`);
    continue;
  }

  console.log(`[START] ${entry.courseCode}/${entry.title}`);

  let videoParts: string[] = [];
  try {
    updateStatus(entry.id, "processing");

    // Split video if longer than 45 minutes — parts go to temp/ so they
    // don't get picked up as new lectures if the run fails midway.
    videoParts = await splitVideoIfNeeded(entry.videoPath, CONFIG.paths.temp);
    const isMultiPart = videoParts.length > 1;

    let finalChatUrl = "";
    let combinedMarkdown = "";
    let actions = null;

    const MAX_RETRIES = 2;

    if (isMultiPart) {
      const markdownParts: string[] = [];

      for (let i = 0; i < videoParts.length; i++) {
        const isLast = i === videoParts.length - 1;
        const prompt = isLast
          ? buildPromptFinalPart(entry.title, entry.courseCode, i + 1, videoParts.length)
          : buildPromptMiddlePart(entry.title, entry.courseCode, i + 1, videoParts.length);

        let partResponse = "";
        let lastErr: unknown;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const { page, context } = await uploadVideoToGemini(videoParts[i]);
          try {
            const { response, chatUrl } = await submitPromptAndWaitForResponse(page, prompt);
            log.info(`Part ${i + 1}/${videoParts.length} (${response.length} chars)`);

            if (response.length < 200 && !response.includes("#")) {
              log.warn(`Part ${i + 1} short response, attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
              lastErr = new Error(`Short response on part ${i + 1}`);
              continue;
            }

            partResponse = response;
            if (isLast) finalChatUrl = chatUrl;
            lastErr = undefined;
            break;
          } catch (err) {
            log.warn(`Part ${i + 1} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
            lastErr = err;
          } finally {
            await context.close();
          }
        }

        if (lastErr !== undefined) throw lastErr;

        const parsed = parseGeminiResponse(partResponse);
        markdownParts.push(parsed.markdown);
        if (isLast) actions = parsed.actions;
      }

      combinedMarkdown = markdownParts.join("\n\n---\n\n");
    } else {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const { page, context } = await uploadVideoToGemini(videoParts[0]);
        try {
          const prompt = buildPrompt(entry.title, entry.courseCode);
          const { response, chatUrl } = await submitPromptAndWaitForResponse(page, prompt);

          if (response.length < 200 && !response.includes("#")) {
            log.warn(`Single-part short response, attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
            lastErr = new Error("Short response");
            continue;
          }

          const parsed = parseGeminiResponse(response);
          finalChatUrl = chatUrl;
          combinedMarkdown = parsed.markdown;
          actions = parsed.actions;
          lastErr = undefined;
          break;
        } catch (err) {
          log.warn(`Single-part attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
          lastErr = err;
        } finally {
          await context.close();
        }
      }
      if (lastErr !== undefined) throw lastErr;
    }

    updateStatus(entry.id, "processed", { gemini_chat_url: finalChatUrl });

    // Write notes
    const lectureDir = writeNotes({
      title: entry.title,
      courseCode: entry.courseCode,
      geminiChatUrl: finalChatUrl,
      markdown: combinedMarkdown,
      actions,
    });

    // Pretty notes (non-fatal)
    try {
      const rawFilePath = path.join(lectureDir, "lecture.raw.md");
      const prettyMarkdown = await prettifyNotes(rawFilePath);
      writePrettyNotes(lectureDir, prettyMarkdown);

      // Sync pretty notes to University workspace (non-fatal)
      try {
        syncToWorkspace(entry.courseCode, path.join(lectureDir, "lecture.pretty.md"));
      } catch (syncErr) {
        log.warn(`Workspace sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
      }
    } catch (err) {
      log.warn(`Pretty notes failed (raw notes preserved): ${err instanceof Error ? err.message : String(err)}`);
    }

    appendTodoItems({
      title: entry.title,
      courseCode: entry.courseCode,
      panoptoUrl: `local://${entry.title}`,
      actions,
    });

    // Move the video into the lecture folder
    moveLectureVideo(entry.videoPath, lectureDir);

    // Clean up temp split parts (if any)
    cleanupParts(videoParts, entry.videoPath);

    updateStatus(entry.id, "complete", { notes_file: lectureDir });
    console.log(`[DONE]  ${entry.courseCode}/${entry.title}`);
    done++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setError(entry.id, msg);
    // Clean up temp split parts so they don't get picked up as new lectures
    cleanupParts(videoParts, entry.videoPath);
    console.error(`[ERROR] ${entry.courseCode}/${entry.title}: ${msg}`);
    errors++;
  }
}

releaseLock();
closeDb();

console.log(`\nComplete: ${done} processed, ${errors} errors, ${pending.length} total`);

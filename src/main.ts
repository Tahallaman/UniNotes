import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { ensureDirectories } from "./utils/paths.js";
import { log } from "./utils/logger.js";
import { withRetry } from "./utils/retry.js";
import { getDb, closeDb } from "./db/schema.js";
import {
  insertLecture,
  getByStatus,
  updateStatus,
  setError,
  resetStaleStatuses,
  resetErroredPanoptoLectures,
} from "./db/tracker.js";
import { scrapePanopto, authPanopto, toNewLecture } from "./panopto/scraper.js";
import { downloadLecture } from "./panopto/downloader.js";
import { uploadVideoToGemini, uploadAdditionalVideoToChat, authGemini } from "./gemini/uploader.js";
import { submitPromptAndWaitForResponse } from "./gemini/prompter.js";
import { buildPrompt, buildPromptMiddlePart, buildPromptFinalPart } from "./gemini/prompts.js";
import { parseGeminiResponse, type ParsedActions } from "./notes/parser.js";
import { splitVideoIfNeeded } from "./utils/videoSplitter.js";
import { writeNotes, writePrettyNotes } from "./notes/writer.js";
import { prettifyNotes } from "./notes/prettifier.js";
import { appendTodoItems } from "./todo/manager.js";
import { syncToWorkspace } from "./utils/workspaceSync.js";

// ── CLI argument handling ──────────────────────────────────────

const args = process.argv.slice(2);
const authMode = args.includes("--auth")
  ? args[args.indexOf("--auth") + 1]
  : null;
const retryErrors = args.includes("--retry");

function loadIgnoredTitles(): Set<string> {
  const p = path.join(CONFIG.rootDir, "ignored-lectures.txt");
  if (!fs.existsSync(p)) return new Set();
  return new Set(
    fs.readFileSync(p, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => l.toLowerCase()),
  );
}

async function main(): Promise<void> {
  ensureDirectories();

  // Handle auth modes
  if (authMode === "panopto") {
    await authPanopto();
    return;
  }
  if (authMode === "gemini") {
    await authGemini();
    return;
  }

  // ── Normal pipeline run ──────────────────────────────────────

  // Acquire file lock to prevent concurrent runs
  if (!acquireLock()) {
    log.warn("Another instance is running (lock file exists). Exiting.");
    return;
  }

  try {
    log.info("=== UniNotes pipeline starting ===");

    // Step 0: Init DB, reset stale statuses
    getDb();
    resetStaleStatuses();
    if (retryErrors) {
      resetErroredPanoptoLectures();
    }

    // Step 1: Scrape Panopto for new lectures
    log.info("Step 1: Scraping Panopto...");
    const newLectures = await withRetry(() => scrapePanopto(), {
      label: "Panopto scrape",
      maxRetries: CONFIG.retry.maxRetries,
      delayMs: CONFIG.retry.delayMs,
    });

    const ignoredTitles = loadIgnoredTitles();
    const isIgnored = (title: string) => ignoredTitles.has(title.toLowerCase().trim());

    for (const lecture of newLectures) {
      if (isIgnored(lecture.title)) {
        log.info(`Ignored lecture (in ignore list): ${lecture.title}`);
        continue;
      }
      insertLecture(toNewLecture(lecture));
    }

    // Step 2: Download new lectures
    log.info("Step 2: Downloading new lectures...");
    const toDownload = getByStatus("new").filter((r) => !isIgnored(r.title));
    for (const lecture of toDownload) {
      try {
        updateStatus(lecture.id, "downloading");
        const tempPath = await withRetry(() => downloadLecture(lecture), {
          label: `Download ${lecture.title}`,
          maxRetries: CONFIG.retry.maxRetries,
          delayMs: CONFIG.retry.delayMs,
        });
        updateStatus(lecture.id, "downloaded", { temp_file: tempPath });
      } catch (err) {
        setError(lecture.id, err instanceof Error ? err.message : String(err));
      }
    }

    // Step 3: Process downloaded lectures through Gemini
    log.info("Step 3: Processing through Gemini...");
    const toProcess = getByStatus("downloaded").filter((r) => !isIgnored(r.title));
    for (const lecture of toProcess) {
      try {
        updateStatus(lecture.id, "processing");

        // Split video if longer than 45 minutes
        const videoParts = await splitVideoIfNeeded(lecture.temp_file!);
        const isMultiPart = videoParts.length > 1;

        let finalChatUrl = "";
        let combinedMarkdown = "";
        let actions: ParsedActions | null = null;

        const MAX_RETRIES = 2;

        if (isMultiPart) {
          // Each part gets its own fresh Gemini chat — Gemini has known bugs
          // with multi-video conversations (ignores subsequent uploads).
          const markdownParts: string[] = [];

          for (let i = 0; i < videoParts.length; i++) {
            const isLast = i === videoParts.length - 1;
            const prompt = isLast
              ? buildPromptFinalPart(lecture.title, lecture.course_code, i + 1, videoParts.length)
              : buildPromptMiddlePart(lecture.title, lecture.course_code, i + 1, videoParts.length);

            let partResponse = "";
            let lastErr: unknown;

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
              const { page, context } = await uploadVideoToGemini(videoParts[i]);
              try {
                const { response, chatUrl } = await submitPromptAndWaitForResponse(page, prompt);
                log.info(`Part ${i + 1}/${videoParts.length} response (${response.length} chars): ${response.slice(0, 200)}`);

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
          // Single video: one chat, full prompt with json-actions
          let lastErr: unknown;
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const { page, context } = await uploadVideoToGemini(videoParts[0]);
            try {
              const prompt = buildPrompt(lecture.title, lecture.course_code);
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

        updateStatus(lecture.id, "processed", { gemini_chat_url: finalChatUrl });

        // Step 4: Parse response → save notes → append TODO
        const lectureDir = writeNotes({
          title: lecture.title,
          courseCode: lecture.course_code,
          panoptoUrl: lecture.panopto_url,
          geminiChatUrl: finalChatUrl,
          markdown: combinedMarkdown,
          actions,
        });

        // Step 4b: Generate pretty notes (non-fatal)
        try {
          const rawFilePath = path.join(lectureDir, "lecture.raw.md");
          const prettyMarkdown = await prettifyNotes(rawFilePath);
          writePrettyNotes(lectureDir, prettyMarkdown);

          // Sync pretty notes to University workspace (non-fatal)
          try {
            syncToWorkspace(lecture.course_code, path.join(lectureDir, "lecture.pretty.md"));
          } catch (syncErr) {
            log.warn(`Workspace sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
          }
        } catch (err) {
          log.warn(`Pretty notes failed (raw notes preserved): ${err instanceof Error ? err.message : String(err)}`);
        }

        appendTodoItems({
          title: lecture.title,
          courseCode: lecture.course_code,
          panoptoUrl: lecture.panopto_url,
          actions,
        });

        // Step 5: Mark complete, delete temp files
        updateStatus(lecture.id, "complete", { notes_file: lectureDir });
        deleteTempFile(lecture.temp_file);
        if (isMultiPart) {
          for (const part of videoParts) {
            deleteTempFile(part);
          }
        }
      } catch (err) {
        setError(lecture.id, err instanceof Error ? err.message : String(err));
      }
    }

    // Summary
    const complete = getByStatus("complete");
    const errors = getByStatus("error");
    log.info(
      `=== Pipeline complete: ${complete.length} done, ${errors.length} errors ===`,
    );
  } finally {
    releaseLock();
    closeDb();
  }
}

// ── Lock file ──────────────────────────────────────────────────

function acquireLock(): boolean {
  try {
    // O_EXCL: fail if file exists (atomic check-and-create)
    const fd = fs.openSync(CONFIG.paths.lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, `${process.pid}`);
    fs.closeSync(fd);
    return true;
  } catch {
    // Check if the lock is stale (process no longer running)
    try {
      const pid = parseInt(fs.readFileSync(CONFIG.paths.lockFile, "utf-8"), 10);
      try {
        process.kill(pid, 0); // Check if process exists
        return false; // Process is alive, lock is valid
      } catch {
        // Process is dead, lock is stale — remove it
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
  } catch {
    // Already removed
  }
}

function deleteTempFile(tempFile: string | null): void {
  if (!tempFile) return;
  try {
    fs.unlinkSync(tempFile);
    log.info(`Deleted temp file: ${tempFile}`);
  } catch {
    log.warn(`Could not delete temp file: ${tempFile}`);
  }
}

// ── Run ────────────────────────────────────────────────────────

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    releaseLock();
    closeDb();
    process.exit(1);
  });

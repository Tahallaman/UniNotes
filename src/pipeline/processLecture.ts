/**
 * The per-lecture pipeline, shared by src/main.ts (Panopto) and
 * scripts/process-local.ts (Incoming/).
 *
 * Both entry points previously carried a near-identical ~150-line copy of this
 * flow, which meant every concurrency change would have had to be written and
 * debugged twice.
 *
 * Everything here is safe to run concurrently for different lectures:
 * better-sqlite3 is synchronous (so DB writes can't interleave mid-statement),
 * writeNotes' duplicate-suffix scan is synchronous end to end, and the global
 * Vertex/GCS/tab caps live in their own modules.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";
import { log, type LogContext } from "../utils/logger.js";
import { splitVideoIfNeeded } from "../utils/videoSplitter.js";
import { syncToWorkspace } from "../utils/workspaceSync.js";
import { writeNotes, writePrettyNotes, moveLectureVideo } from "../notes/writer.js";
import { prettifyNotes } from "../notes/prettifier.js";
import { appendTodoItems } from "../todo/manager.js";
import { updateStatus } from "../db/tracker.js";
import { createApiRunner } from "../gemini/apiProcessor.js";
import { createBrowserRunner } from "./browserNotes.js";
import { runLectureParts } from "./partRunner.js";
import { clearCheckpoint } from "./checkpoint.js";
import type { NotesProvider } from "../utils/uploaderMode.js";

export interface LectureJob {
  id: string;
  title: string;
  courseCode: string;
  /** The video to process. */
  videoPath: string;
  /** Recorded in frontmatter and TODO.md. Local videos use "local://<title>". */
  panoptoUrl?: string;
  /**
   * Where split parts are written. Local runs put them in temp/ so a mid-run
   * crash can't leave them looking like new Incoming lectures.
   */
  partsDir?: string;
  /**
   * What to do with the source video once notes exist:
   *   "delete" — Panopto downloads live in temp/ and are disposable
   *   "move"   — Incoming/ videos are archived into the lecture folder
   */
  onComplete: "delete" | "move";
}

export interface LectureResult {
  lectureDir: string;
  prettyOk: boolean;
}

/** Resolved once by the entry point so CLI flags override config consistently. */
export interface Providers {
  notes: NotesProvider;
  pretty: NotesProvider;
}

export async function processLecture(
  job: LectureJob,
  providers: Providers,
): Promise<LectureResult> {
  const provider = providers.notes;
  const ctx: LogContext = { label: `${job.courseCode} · ${job.title}` };
  let videoParts: string[] = [];

  try {
    updateStatus(job.id, "processing");

    // Split into CONFIG.segmentSeconds chunks (15 min) if the video is longer.
    videoParts = await splitVideoIfNeeded(job.videoPath, job.partsDir);
    if (videoParts.length > 1) {
      log.info(`Split into ${videoParts.length} parts (${CONFIG.segmentSeconds}s each)`, ctx);
    }

    const result = await runLectureParts({
      lectureId: job.id,
      lectureTitle: job.title,
      courseCode: job.courseCode,
      videoParts,
      sourceVideoPath: job.videoPath,
      runner: provider === "api" ? createApiRunner(job.id) : createBrowserRunner(),
      ctx,
    });

    updateStatus(job.id, "processed", { gemini_chat_url: result.chatUrl });

    const lectureDir = writeNotes({
      title: job.title,
      courseCode: job.courseCode,
      panoptoUrl: job.panoptoUrl,
      geminiChatUrl: result.chatUrl,
      markdown: result.markdown,
      actions: result.actions,
    });

    // Raw notes are safely on disk now, so the checkpoint has done its job.
    clearCheckpoint(job.id);

    // Non-fatal. If it fails, the next run's pretty backfill picks it up.
    const prettyOk = await generatePretty(lectureDir, job.courseCode, providers.pretty, ctx);

    appendTodoItems({
      title: job.title,
      courseCode: job.courseCode,
      panoptoUrl: job.panoptoUrl ?? `local://${job.title}`,
      actions: result.actions,
    });

    if (job.onComplete === "move") {
      moveLectureVideo(job.videoPath, lectureDir);
    } else {
      deleteFile(job.videoPath, ctx);
    }
    cleanupParts(videoParts, job.videoPath);

    updateStatus(job.id, "complete", { notes_file: lectureDir });
    return { lectureDir, prettyOk };
  } catch (err) {
    // Deliberately keep the split parts and the checkpoint on failure — they are
    // exactly what lets the next run resume instead of regenerating every part.
    // They're cleaned up on the eventual success, and the checkpoint fingerprint
    // discards them if the source video or split settings change.
    log.warn(
      `Lecture failed; keeping ${videoParts.length} split part(s) and checkpoint for resume.`,
      ctx,
    );
    throw err;
  }
}

/**
 * Prettify + workspace sync. Non-fatal by design: the raw notes are the valuable
 * artefact, and a formatting failure must not lose them or fail the lecture.
 */
async function generatePretty(
  lectureDir: string,
  courseCode: string,
  provider: NotesProvider,
  ctx: LogContext,
): Promise<boolean> {
  try {
    const rawFilePath = path.join(lectureDir, "lecture.raw.md");
    const prettyMarkdown = await prettifyNotes(rawFilePath, { provider, ctx });
    writePrettyNotes(lectureDir, prettyMarkdown);

    try {
      syncToWorkspace(courseCode, path.join(lectureDir, "lecture.pretty.md"));
    } catch (syncErr) {
      log.warn(
        `Workspace sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
        ctx,
      );
    }
    return true;
  } catch (err) {
    log.warn(
      `Pretty notes failed (raw notes preserved): ${err instanceof Error ? err.message : String(err)}`,
      ctx,
    );
    return false;
  }
}

/** Remove split part files, skipping the original video. */
function cleanupParts(parts: string[], originalPath: string): void {
  for (const part of parts) {
    if (part === originalPath) continue;
    try {
      fs.unlinkSync(part);
    } catch {
      // Already gone, or still locked by a crashed ffmpeg — not worth failing over.
    }
  }
}

function deleteFile(filePath: string | null | undefined, ctx: LogContext): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
    log.info(`Deleted temp file: ${filePath}`, ctx);
  } catch {
    log.warn(`Could not delete temp file: ${filePath}`, ctx);
  }
}

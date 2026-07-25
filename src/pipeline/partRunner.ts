/**
 * Shared per-part orchestration for both providers.
 *
 * Owns everything that must behave identically regardless of whether notes come
 * from Vertex or the web UI: concurrency, input-order reassembly, checkpointing,
 * and timestamp rebasing. The providers only supply "run this one part".
 */

import { CONFIG } from "../../config.js";
import { log, type LogContext } from "../utils/logger.js";
import { mapWithLimit } from "../utils/limit.js";
import { shiftTimestamps, partOffsetSeconds } from "../utils/timestamps.js";
import { analyseBlankness, blankSegmentNote, BLANK_SEGMENT_MARKER } from "../utils/blankVideo.js";
import { getVideoDuration } from "../utils/videoSplitter.js";
import { parseGeminiResponse, type ParsedActions } from "../notes/parser.js";
import { buildPrompt, buildPromptMiddlePart, buildPromptFinalPart } from "../gemini/prompts.js";
import {
  computeFingerprint,
  loadCheckpoint,
  savePart,
  saveActions,
} from "./checkpoint.js";

export interface PartRunner {
  name: "api" | "browser";
  runPart(opts: {
    videoPath: string;
    prompt: string;
    partNum: number;
    totalParts: number;
    ctx: LogContext;
  }): Promise<{ raw: string; chatUrl: string }>;
}

export interface LectureNotesResult {
  markdown: string;
  actions: ParsedActions | null;
  chatUrl: string;
  /** Segments skipped as empty, counted across resumed runs too. */
  blankParts: number;
}

/**
 * The most recent part that actually held a conversation.
 *
 * A blank final segment is skipped without a model call, so it has no chat URL —
 * and the lecture would otherwise link to nothing. Walks backwards to the last
 * part that was really generated.
 */
function findLastChatUrl(chatUrls: Map<number, string>, totalParts: number): string {
  for (let partNum = totalParts - 1; partNum >= 1; partNum--) {
    const url = chatUrls.get(partNum);
    if (url) return url;
  }
  return "";
}

export async function runLectureParts(opts: {
  lectureId: string;
  lectureTitle: string;
  courseCode: string;
  videoParts: string[];
  sourceVideoPath: string;
  runner: PartRunner;
  ctx: LogContext;
}): Promise<LectureNotesResult> {
  const { lectureId, lectureTitle, courseCode, videoParts, sourceVideoPath, runner, ctx } = opts;
  const totalParts = videoParts.length;

  if (totalParts === 0) {
    throw new Error("runLectureParts called with no video parts");
  }

  const fingerprint = computeFingerprint(sourceVideoPath, totalParts, runner.name);
  const checkpoint = loadCheckpoint(lectureId, fingerprint, ctx);

  // Only generate what isn't already on disk from a previous run.
  const pending = Array.from({ length: totalParts }, (_, i) => i + 1).filter(
    (partNum) => !checkpoint.parts.has(partNum),
  );

  if (pending.length === 0) {
    log.info("All parts already checkpointed — skipping generation.", ctx);
  } else if (pending.length < totalParts) {
    log.info(`Generating ${pending.length} remaining part(s): ${pending.join(", ")}`, ctx);
  }

  let latestActions: ParsedActions | null = checkpoint.actions;

  await mapWithLimit(pending, CONFIG.concurrency.parts, async (partNum) => {
    const isLast = partNum === totalParts;
    const partCtx: LogContext = {
      ...ctx,
      part: totalParts === 1 ? "single" : `${partNum}/${totalParts}`,
    };

    const offsetSeconds = partOffsetSeconds(partNum, CONFIG.segmentSeconds);

    // Checked per part, not per lecture: a recording that starts late is blank
    // for its first two or three segments and perfectly good after that. Those
    // segments are also exactly where the model invents — asked to write notes
    // on "part 2 of 8" of a named course with nothing on screen, it produces a
    // plausible syllabus rather than reporting the silence. Skipping them saves
    // a Gemini call each AND removes the opportunity.
    if (CONFIG.blankDetection.enabled) {
      const partPath = videoParts[partNum - 1];
      const partDuration = await getVideoDuration(partPath).catch(() => CONFIG.segmentSeconds);
      const analysis = await analyseBlankness(partPath, partDuration, partCtx);
      if (analysis.blank) {
        const placeholder = blankSegmentNote(offsetSeconds, partDuration);
        log.info(`Blank segment — skipped without a model call (${analysis.summary}).`, partCtx);
        checkpoint.parts.set(partNum, placeholder);
        checkpoint.chatUrls.set(partNum, "");
        savePart(lectureId, fingerprint, totalParts, runner.name, partNum, placeholder, "");
        return;
      }
    }

    const prompt =
      totalParts === 1
        ? buildPrompt(lectureTitle, courseCode)
        : isLast
          ? buildPromptFinalPart(lectureTitle, courseCode, partNum, totalParts)
          : buildPromptMiddlePart(lectureTitle, courseCode, partNum, totalParts);

    const { raw, chatUrl } = await runner.runPart({
      videoPath: videoParts[partNum - 1],
      prompt,
      partNum,
      totalParts,
      ctx: partCtx,
    });

    // Only the final part (or an unsplit lecture) is asked for json-actions.
    const parsed = parseGeminiResponse(raw, isLast || totalParts === 1);

    // Gemini sees each part as its own video starting at 00:00, so rebase onto
    // the real lecture timeline before anything else consumes the markdown.
    const markdown = shiftTimestamps(parsed.markdown, offsetSeconds);
    if (offsetSeconds > 0) {
      log.debug(`Shifted timestamps by +${offsetSeconds}s`, partCtx);
    }

    checkpoint.parts.set(partNum, markdown);
    checkpoint.chatUrls.set(partNum, chatUrl);
    savePart(lectureId, fingerprint, totalParts, runner.name, partNum, markdown, chatUrl);

    // Only the final part is prompted for the whole-lecture actions block.
    if (isLast) {
      latestActions = parsed.actions;
      saveActions(lectureId, parsed.actions);
    }
  });

  // Reassemble positionally — never in completion order.
  const ordered: string[] = [];
  for (let partNum = 1; partNum <= totalParts; partNum++) {
    const markdown = checkpoint.parts.get(partNum);
    if (markdown === undefined) {
      throw new Error(`Part ${partNum}/${totalParts} is missing after generation`);
    }
    ordered.push(markdown);
  }

  // Counted from the assembled markdown rather than a running tally, so parts
  // restored from a checkpoint on a resumed run are recognised too.
  const blankParts = ordered.filter((m) => m.includes(BLANK_SEGMENT_MARKER)).length;

  return {
    markdown: ordered.join("\n\n---\n\n"),
    actions: latestActions,
    // The last part carries the conversation, unless it was blank and never had one.
    chatUrl: checkpoint.chatUrls.get(totalParts) || findLastChatUrl(checkpoint.chatUrls, totalParts),
    blankParts,
  };
}

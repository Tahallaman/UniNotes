import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../../config.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Get the duration of a video file in seconds using ffprobe.
 */
export async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-select_streams", "v:0",
    videoPath,
  ], { maxBuffer: 10 * 1024 * 1024 });
  const info = JSON.parse(stdout) as { streams?: Array<{ duration?: string }> };
  const duration = parseFloat(info.streams?.[0]?.duration ?? "0");
  if (!duration) throw new Error("ffprobe returned no duration for video");
  return duration;
}

/**
 * Split a video into N segments of `segmentSeconds` each using ffmpeg stream copy.
 * Returns an array of file paths for each part.
 */
async function splitIntoParts(
  videoPath: string,
  duration: number,
  segmentSeconds: number,
  outputDir?: string,
): Promise<string[]> {
  const ext = path.extname(videoPath);
  const basename = path.basename(videoPath, ext);
  const dir = outputDir ?? path.dirname(videoPath);
  const numParts = Math.ceil(duration / segmentSeconds);
  const parts: string[] = [];

  log.info(`Splitting video into ${numParts} parts (${segmentSeconds}s each) using ffmpeg stream copy...`);

  for (let i = 0; i < numParts; i++) {
    const startSec = i * segmentSeconds;
    const partPath = path.join(dir, `${basename}_part${i + 1}${ext}`);

    const args = [
      "-y", "-ss", String(startSec), "-i", videoPath,
    ];
    // For all parts except the last, limit duration
    if (i < numParts - 1) {
      args.push("-t", String(segmentSeconds));
    }
    args.push("-c", "copy", partPath);

    log.info(`Splitting part ${i + 1}/${numParts}...`);
    await execFileAsync("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
    parts.push(partPath);
  }

  log.info(`Split complete: ${parts.map((p) => path.basename(p)).join(", ")}`);
  return parts;
}

/**
 * If the video exceeds 20 minutes, split it into N segments and return their paths.
 * Otherwise, return the original path as a single-element array.
 *
 * The original file is NOT deleted — callers are responsible for cleanup.
 */
export async function splitVideoIfNeeded(videoPath: string, outputDir?: string): Promise<string[]> {
  let duration: number;
  try {
    duration = await getVideoDuration(videoPath);
  } catch (err) {
    log.warn(`Could not determine video duration, processing as-is: ${err}`);
    return [videoPath];
  }

  log.info(
    `Video duration: ${Math.round(duration)}s (${(duration / 60).toFixed(1)} min)`,
  );

  if (duration <= CONFIG.segmentSeconds) {
    return [videoPath];
  }

  const numParts = Math.ceil(duration / CONFIG.segmentSeconds);
  log.info(`Video exceeds ${CONFIG.segmentSeconds / 60} minutes — splitting into ${numParts} parts...`);
  return splitIntoParts(videoPath, duration, CONFIG.segmentSeconds, outputDir);
}

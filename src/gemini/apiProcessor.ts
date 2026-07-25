import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "../../config.js";
import { log, type LogContext } from "../utils/logger.js";
import type { PartRunner } from "../pipeline/partRunner.js";
import {
  getStorage,
  resolveBucketName,
  resolveBucketLocation,
  vertexLimit,
  gcsLimit,
  RUN_ID,
  classifyError,
  backoffDelay,
  sleep,
} from "./vertexClient.js";
import { generateText } from "./vertexGenerate.js";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
};

/**
 * Ensure the GCS bucket exists.
 *
 * Memoises the PROMISE, not a boolean. A boolean flag lets every concurrent
 * caller past the check before the first one finishes, and they all race into
 * createBucket() — which 409s for all but one.
 */
let bucketPromise: Promise<string> | null = null;
function ensureBucket(): Promise<string> {
  if (!bucketPromise) {
    bucketPromise = (async () => {
      const bucketName = resolveBucketName();
      const bucket = getStorage().bucket(bucketName);
      const [exists] = await bucket.exists();
      if (!exists) {
        log.info(`Creating GCS bucket "${bucketName}" in ${resolveBucketLocation()}...`);
        await getStorage().createBucket(bucketName, {
          location: resolveBucketLocation(),
          uniformBucketLevelAccess: true,
        });
        log.info(`Bucket "${bucketName}" created.`);
      }
      return bucketName;
    })().catch((err) => {
      // Don't cache a failure — a transient error would poison every later call.
      bucketPromise = null;
      throw err;
    });
  }
  return bucketPromise;
}

interface StagedUpload {
  gcsUri: string;
  mimeType: string;
  cleanup: () => Promise<void>;
}

/**
 * Upload a video chunk to GCS and return its gs:// URI plus a cleanup function.
 *
 * The object key is namespaced by RUN_ID *and* the lecture key. The previous
 * scheme keyed only on Date.now(), so two lectures starting in the same
 * millisecond wrote to the same path and clobbered each other.
 */
async function uploadChunkToGcs(
  videoPath: string,
  lectureKey: string,
  partNum: number,
  ctx: LogContext,
): Promise<StagedUpload> {
  const bucketName = await ensureBucket();
  const ext = path.extname(videoPath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || "video/mp4";
  const destination = `uploads/${RUN_ID}/${lectureKey}/part-${partNum}${ext || ".mp4"}`;
  const gcsUri = `gs://${bucketName}/${destination}`;
  const bucket = getStorage().bucket(bucketName);

  // Upload under the GCS limiter only. It is released before the caller takes a
  // Vertex slot, so the two global caps are never held simultaneously.
  await gcsLimit(async () => {
    log.info(`Uploading ${path.basename(videoPath)} → ${gcsUri}`, ctx);
    await bucket.upload(videoPath, { destination });
    log.info("Upload to GCS complete.", ctx);
  });

  const cleanup = async () => {
    if (!CONFIG.vertex.cleanupUploads) return;
    try {
      await bucket.file(destination).delete();
      log.debug(`Deleted GCS object: ${gcsUri}`, ctx);
    } catch (err) {
      log.warn(
        `Could not delete GCS object ${gcsUri}: ${err instanceof Error ? err.message : String(err)}`,
        ctx,
      );
    }
  };

  return { gcsUri, mimeType, cleanup };
}

/** Upload with its own retry budget, so a flaky upload doesn't consume generation attempts. */
async function uploadWithRetry(
  videoPath: string,
  lectureKey: string,
  partNum: number,
  ctx: LogContext,
): Promise<StagedUpload> {
  const maxRetries = CONFIG.retry.maxRetries;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await uploadChunkToGcs(videoPath, lectureKey, partNum, ctx);
    } catch (err) {
      lastErr = err;
      const { retryable, rateLimited, reason } = classifyError(err);
      if (!retryable || attempt === maxRetries) break;
      const wait = backoffDelay(attempt, rateLimited);
      log.warn(`GCS upload failed (${reason}) — retrying in ${wait}ms`, ctx);
      await sleep(wait);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("GCS upload failed");
}

/**
 * Vertex AI implementation of the PartRunner contract.
 *
 * Ordering, checkpointing and timestamp rebasing live in pipeline/partRunner.ts;
 * this only knows how to turn one video part into one raw response.
 */
export function createApiRunner(lectureKey: string): PartRunner {
  const key = sanitiseKey(lectureKey);
  return {
    name: "api",
    async runPart({ videoPath, prompt, partNum, ctx }) {
      const raw = await processOnePart({ videoPath, prompt, lectureKey: key, partNum, ctx });
      // No web conversation exists on the API path.
      return { raw, chatUrl: "" };
    },
  };
}

/** Returns the RAW response text; the caller parses it. */
async function processOnePart(opts: {
  videoPath: string;
  prompt: string;
  lectureKey: string;
  partNum: number;
  ctx: LogContext;
}): Promise<string> {
  const { videoPath, prompt, lectureKey, partNum, ctx } = opts;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video part not found: ${videoPath}`);
  }

  // Upload ONCE, outside the generation retry loop. Previously the upload sat
  // inside the loop, so a single 429 re-uploaded the entire video chunk.
  const staged = await uploadWithRetry(videoPath, lectureKey, partNum, ctx);
  const maxRetries = CONFIG.retry.maxRetries;
  let lastErr: unknown;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await vertexLimit(() =>
          generateText({
            model: CONFIG.vertex.model,
            parts: [
              { fileData: { fileUri: staged.gcsUri, mimeType: staged.mimeType } },
              { text: prompt },
            ],
            maxOutputTokens: CONFIG.vertex.generation.notes.maxOutputTokens,
            thinkingLevel: CONFIG.vertex.generation.notes.thinkingLevel,
            ctx,
          }),
        );

        log.info(`Response: ${response.length} chars`, ctx);

        if (response.length < 200 && !response.includes("#")) {
          lastErr = new Error(`Short response (${response.length} chars)`);
          log.warn(`Short response, attempt ${attempt + 1}/${maxRetries + 1}`, ctx);
          if (attempt < maxRetries) await sleep(backoffDelay(attempt, false));
          continue;
        }

        return response;
      } catch (err) {
        lastErr = err;
        const { retryable, rateLimited, reason } = classifyError(err);
        if (!retryable) {
          log.error(`Not retryable — ${reason}`, ctx);
          break;
        }
        if (attempt === maxRetries) break;
        const wait = backoffDelay(attempt, rateLimited);
        log.warn(`Attempt ${attempt + 1}/${maxRetries + 1} failed (${reason}) — retrying in ${wait}ms`, ctx);
        await sleep(wait);
      }
    }
  } finally {
    await staged.cleanup();
  }

  throw lastErr instanceof Error ? lastErr : new Error("Vertex generation failed after retries");
}

/** Make an arbitrary lecture identifier safe for a GCS object path. */
function sanitiseKey(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned || "lecture";
}

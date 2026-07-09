import path from "node:path";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { Storage } from "@google-cloud/storage";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import {
  buildPrompt,
  buildPromptMiddlePart,
  buildPromptFinalPart,
} from "./prompts.js";
import { parseGeminiResponse, type ParsedActions } from "../notes/parser.js";

export interface ApiProcessResult {
  markdown: string;
  actions: ParsedActions | null;
  chatUrl: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
};

/** Request timeout for a single generateContent call (ms). */
const GENERATE_TIMEOUT_MS = 30 * 60_000;

function resolveProject(): string {
  return process.env.GOOGLE_CLOUD_PROJECT || CONFIG.vertex.project;
}

function resolveLocation(): string {
  return process.env.GOOGLE_CLOUD_LOCATION || CONFIG.vertex.location;
}

function resolveBucketName(): string {
  return process.env.UNINOTES_GCS_BUCKET || CONFIG.vertex.gcsBucket;
}

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      vertexai: true,
      project: resolveProject(),
      location: resolveLocation(),
    });
  }
  return cachedClient;
}

let cachedStorage: Storage | null = null;
function getStorage(): Storage {
  if (!cachedStorage) {
    cachedStorage = new Storage({ projectId: resolveProject() });
  }
  return cachedStorage;
}

let bucketEnsured = false;
async function ensureBucket(): Promise<string> {
  const bucketName = resolveBucketName();
  if (bucketEnsured) return bucketName;

  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  const [exists] = await bucket.exists();
  if (!exists) {
    log.info(`Creating GCS bucket "${bucketName}" in ${resolveLocation()}...`);
    await storage.createBucket(bucketName, {
      location: resolveLocation(),
      uniformBucketLevelAccess: true,
    });
    log.info(`Bucket "${bucketName}" created.`);
  }
  bucketEnsured = true;
  return bucketName;
}

/**
 * Upload a video chunk to GCS under uploads/<timestamp>/part-N.mp4 and return
 * its gs:// URI plus a cleanup function.
 */
async function uploadChunkToGcs(
  videoPath: string,
  uploadTimestamp: string,
  partNum: number,
): Promise<{ gcsUri: string; mimeType: string; cleanup: () => Promise<void> }> {
  const bucketName = await ensureBucket();
  const ext = path.extname(videoPath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || "video/mp4";
  const destination = `uploads/${uploadTimestamp}/part-${partNum}${ext || ".mp4"}`;

  log.info(`Uploading ${path.basename(videoPath)} to gs://${bucketName}/${destination}...`);
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  await bucket.upload(videoPath, { destination });
  log.info(`Upload to GCS complete: gs://${bucketName}/${destination}`);

  const gcsUri = `gs://${bucketName}/${destination}`;
  const cleanup = async () => {
    if (!CONFIG.vertex.cleanupUploads) return;
    try {
      await bucket.file(destination).delete();
      log.info(`Deleted GCS object: ${gcsUri}`);
    } catch (err) {
      log.warn(`Could not delete GCS object ${gcsUri}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { gcsUri, mimeType, cleanup };
}

/**
 * Call Gemini via Vertex AI with a video (as a GCS file reference) and a text prompt.
 * Returns the raw response text.
 */
async function generateFromVideo(gcsUri: string, mimeType: string, prompt: string): Promise<string> {
  const client = getClient();
  const response = await client.models.generateContent({
    model: CONFIG.vertex.model,
    contents: [
      { fileData: { fileUri: gcsUri, mimeType } },
      { text: prompt },
    ],
    config: {
      httpOptions: { timeout: GENERATE_TIMEOUT_MS },
    },
  });

  return response.text ?? "";
}

/**
 * Process one or more video part files through Vertex AI Gemini, returning the same
 * shape main.ts's browser-path assembly produces: combined markdown, actions parsed
 * from the final part, and an (empty) chatUrl — there is no web chat on the API path.
 *
 * Multi-part semantics mirror main.ts: each part is processed independently (its own
 * upload), non-final parts use buildPromptMiddlePart, the final part uses
 * buildPromptFinalPart and supplies the actions; parts are joined with "\n\n---\n\n".
 * Single-part uses buildPrompt.
 */
export async function processLectureViaApi(
  lectureTitle: string,
  courseCode: string,
  videoPartPaths: string[],
): Promise<ApiProcessResult> {
  if (videoPartPaths.length === 0) {
    throw new Error("processLectureViaApi called with no video parts");
  }

  const uploadTimestamp = Date.now().toString();
  const isMultiPart = videoPartPaths.length > 1;
  const MAX_RETRIES = CONFIG.retry.maxRetries;

  let actions: ParsedActions | null = null;

  if (isMultiPart) {
    const markdownParts: string[] = [];

    for (let i = 0; i < videoPartPaths.length; i++) {
      const isLast = i === videoPartPaths.length - 1;
      const prompt = isLast
        ? buildPromptFinalPart(lectureTitle, courseCode, i + 1, videoPartPaths.length)
        : buildPromptMiddlePart(lectureTitle, courseCode, i + 1, videoPartPaths.length);

      const partMarkdown = await processOnePart({
        videoPath: videoPartPaths[i],
        prompt,
        partLabel: `Part ${i + 1}/${videoPartPaths.length}`,
        uploadTimestamp,
        partNum: i + 1,
        maxRetries: MAX_RETRIES,
        onFinalActions: isLast
          ? (parsed) => {
              actions = parsed.actions;
            }
          : undefined,
      });

      markdownParts.push(partMarkdown);
    }

    return {
      markdown: markdownParts.join("\n\n---\n\n"),
      actions,
      chatUrl: "",
    };
  }

  // Single part
  const prompt = buildPrompt(lectureTitle, courseCode);
  const markdown = await processOnePart({
    videoPath: videoPartPaths[0],
    prompt,
    partLabel: "Single-part",
    uploadTimestamp,
    partNum: 1,
    maxRetries: MAX_RETRIES,
    onFinalActions: (parsed) => {
      actions = parsed.actions;
    },
  });

  return { markdown, actions, chatUrl: "" };
}

async function processOnePart(opts: {
  videoPath: string;
  prompt: string;
  partLabel: string;
  uploadTimestamp: string;
  partNum: number;
  maxRetries: number;
  onFinalActions?: (parsed: ReturnType<typeof parseGeminiResponse>) => void;
}): Promise<string> {
  const { videoPath, prompt, partLabel, uploadTimestamp, partNum, maxRetries, onFinalActions } = opts;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video part not found: ${videoPath}`);
  }

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { gcsUri, mimeType, cleanup } = await uploadChunkToGcs(videoPath, uploadTimestamp, partNum);
    try {
      log.info(`${partLabel}: requesting Gemini (Vertex AI, ${CONFIG.vertex.model})...`);
      const response = await generateFromVideo(gcsUri, mimeType, prompt);
      log.info(`${partLabel} response (${response.length} chars): ${response.slice(0, 200)}`);

      if (response.length < 200 && !response.includes("#")) {
        log.warn(`${partLabel} short response, attempt ${attempt + 1}/${maxRetries + 1}`);
        lastErr = new Error(`Short response on ${partLabel}`);
        continue;
      }

      const parsed = parseGeminiResponse(response);
      onFinalActions?.(parsed);
      lastErr = undefined;
      return parsed.markdown;
    } catch (err) {
      log.warn(`${partLabel} attempt ${attempt + 1}/${maxRetries + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      lastErr = err;
    } finally {
      await cleanup();
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`${partLabel} failed after retries`);
}

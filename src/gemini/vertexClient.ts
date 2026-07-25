/**
 * Shared Vertex AI client plumbing.
 *
 * Extracted from apiProcessor.ts so the prettifier can make text-only calls
 * without dragging in the GCS/video machinery. Both clients are process-wide
 * singletons and are safe to share across concurrent calls.
 */

import { GoogleGenAI } from "@google/genai";
import { Storage } from "@google-cloud/storage";
import { CONFIG } from "../../config.js";
import { createLimiter } from "../utils/limit.js";

export function resolveProject(): string {
  return process.env.GOOGLE_CLOUD_PROJECT || CONFIG.vertex.project;
}

export function resolveLocation(): string {
  return process.env.GOOGLE_CLOUD_LOCATION || CONFIG.vertex.location;
}

export function resolveBucketName(): string {
  return process.env.UNINOTES_GCS_BUCKET || CONFIG.vertex.gcsBucket;
}

export function resolveBucketLocation(): string {
  return process.env.UNINOTES_GCS_BUCKET_LOCATION || CONFIG.vertex.bucketLocation;
}

let cachedClient: GoogleGenAI | null = null;
export function getClient(): GoogleGenAI {
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
export function getStorage(): Storage {
  if (!cachedStorage) {
    cachedStorage = new Storage({ projectId: resolveProject() });
  }
  return cachedStorage;
}

/**
 * Global caps, shared by every caller in the process so that
 * lectures × parts can't multiply into a quota stampede.
 *
 * Never hold both at once — upload under `gcsLimit`, release, then generate
 * under `vertexLimit`. See src/utils/limit.ts.
 */
export const vertexLimit = createLimiter(CONFIG.concurrency.vertexInFlight);
export const gcsLimit = createLimiter(CONFIG.concurrency.gcsUploads);

/** Unique per process — namespaces GCS uploads so concurrent runs can't collide. */
export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ── Error classification ───────────────────────────────────────

/** Pull an HTTP-ish status code out of whatever shape the SDK threw. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ["status", "code", "statusCode"]) {
    const v = e[key];
    if (typeof v === "number" && v >= 100 && v < 600) return v;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Is this worth retrying?
 *
 * Vertex serves current Flash tiers from a dynamic shared quota pool, so 429s are
 * routine capacity signals rather than a misconfiguration — they deserve a longer
 * backoff. 400/401/403/404 are permanent (bad model ID, missing role, billing off)
 * and must fail on the first attempt instead of burning the whole retry budget.
 */
export function classifyError(err: unknown): {
  retryable: boolean;
  rateLimited: boolean;
  reason: string;
} {
  // An error may declare its own verdict (see TruncatedResponseError) — trust it.
  if (typeof err === "object" && err !== null && "retryable" in err) {
    const declared = (err as { retryable: unknown }).retryable;
    if (typeof declared === "boolean") {
      return { retryable: declared, rateLimited: false, reason: messageOf(err).slice(0, 160) };
    }
  }

  const status = statusOf(err);
  const msg = messageOf(err);
  const upper = msg.toUpperCase();

  const rateLimited =
    status === 429 ||
    upper.includes("RESOURCE_EXHAUSTED") ||
    upper.includes("TOO MANY REQUESTS") ||
    upper.includes("QUOTA");

  if (rateLimited) {
    return { retryable: true, rateLimited: true, reason: `rate limited (${status ?? "429"})` };
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return { retryable: false, rateLimited: false, reason: `permanent client error ${status}` };
  }

  if (
    status === 500 || status === 503 || status === 504 ||
    upper.includes("UNAVAILABLE") ||
    upper.includes("DEADLINE_EXCEEDED") ||
    upper.includes("INTERNAL") ||
    upper.includes("ECONNRESET") ||
    upper.includes("ETIMEDOUT") ||
    upper.includes("SOCKET HANG UP")
  ) {
    return { retryable: true, rateLimited: false, reason: `transient (${status ?? "network"})` };
  }

  // Unknown shape — retry once rather than failing a long pipeline on a guess.
  return { retryable: true, rateLimited: false, reason: `unclassified: ${msg.slice(0, 120)}` };
}

/** Exponential backoff with full jitter; rate-limit errors wait considerably longer. */
export function backoffDelay(attempt: number, rateLimited: boolean): number {
  const base = rateLimited ? 8_000 : CONFIG.retry.delayMs;
  const cap = rateLimited ? 120_000 : 30_000;
  const exponential = Math.min(cap, base * 2 ** attempt);
  // Full jitter — without it, parallel workers that hit the same 429 would
  // retry in lockstep and trip the limit again together.
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

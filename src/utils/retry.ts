import { log } from "./logger.js";

interface RetryOptions {
  maxRetries?: number;
  delayMs?: number;
  label?: string;
}

/**
 * Retry a function with exponential backoff.
 * On final failure, throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, delayMs = 2_000, label = "operation" } = opts;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt > maxRetries;
      const msg = err instanceof Error ? err.message : String(err);

      if (isLast) {
        log.error(`${label} failed after ${attempt} attempts: ${msg}`);
        throw err;
      }

      const wait = delayMs * Math.pow(2, attempt - 1);
      log.warn(`${label} attempt ${attempt} failed: ${msg} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`${label} failed`);
}

/**
 * Minimal concurrency limiter.
 *
 * Deliberately dependency-free: p-limit exists in node_modules only as a
 * transitive dependency of @google-cloud/storage, and importing something we
 * don't declare would break the moment that dependency tree changes.
 *
 * DEADLOCK RULE: never hold two shared limiters at the same time. Acquire the
 * GCS slot, upload, release it, and only then acquire the Vertex slot. Nesting
 * two *independent* limiters (e.g. per-lecture inside per-part) is safe because
 * neither is reentrant and every task always releases.
 */

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Create a limiter allowing at most `max` concurrent tasks.
 * `max <= 1` degrades to strict serialisation, which is the intended escape
 * hatch for debugging — set every CONFIG.concurrency value to 1.
 */
export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active--;
    // Wake exactly one waiter so `active` can never exceed `limit`.
    //
    // Safe despite the momentary dip below `limit`: the decrement and the wake
    // are adjacent synchronous statements, and resolve() queues the waiter's
    // continuation as a microtask. Microtasks drain FIFO before any macrotask,
    // so the woken waiter always re-increments before another caller can
    // observe the dip. Verified against an adversarial interleaving test.
    queue.shift()?.();
  };

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * Map over `items` with bounded concurrency.
 *
 * Results are returned in INPUT ORDER, not completion order. This is load-bearing:
 * lecture part markdown is joined positionally ("\n\n---\n\n"), so an out-of-order
 * result would silently scramble a lecture rather than raise an error.
 *
 * Rejects on the first failure, matching Promise.all. In-flight tasks are allowed
 * to settle rather than being abandoned mid-write.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const run = createLimiter(limit);
  const results = new Array<R>(items.length);

  await Promise.all(
    items.map((item, index) =>
      run(async () => {
        results[index] = await fn(item, index);
      }),
    ),
  );

  return results;
}

/**
 * Like mapWithLimit but never rejects — returns a per-item settled result in
 * input order. Used where one bad lecture must not abort the whole run.
 */
export async function mapWithLimitSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  return mapWithLimit(items, limit, async (item, index) => {
    try {
      return { ok: true as const, value: await fn(item, index) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
}

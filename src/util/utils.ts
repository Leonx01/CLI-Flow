/**
 * Cliflow utility functions.
 */

/** Simple stderr logger. */
export const log = {
  info: (...args: unknown[]) => console.error('[cliflow]', ...args),
  warn: (...args: unknown[]) => console.error('[cliflow:warn]', ...args),
  debug: process.env.DEBUG ? (...args: unknown[]) => console.error('[cliflow:debug]', ...args) : undefined,
};

/** Simple async concurrency limiter. */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      if (signal?.aborted) break;
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Pause for the given number of milliseconds. Rejects early if signal is aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Type guard: checks if a value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

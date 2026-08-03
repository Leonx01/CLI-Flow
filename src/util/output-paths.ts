/**
 * Shared output-path extraction — PURE module (no Node built-ins), safe to
 * import from the browser bundle (Vite) and from the TUI.
 *
 * Adapters write files wherever they choose and report them back in their
 * step output. The shape varies by adapter — `local/save-json` returns
 * `[{ path, size }]`, `local/radar-report` returns `[{ file, rows }]`, some
 * adapters return a plain path string. This module normalizes those shapes
 * into a single deduplicated array of paths.
 *
 * Paths are returned as the adapter reported them (usually already absolute);
 * callers that need resolution/validation do it server-side.
 */

/** Heuristic: does a string look like a filesystem path? */
function looksLikePath(s: string): boolean {
  if (!s) return false;
  // Relative or absolute: ./x, ../x, /x, ~/x, C:\x, C:/x
  return /^(\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(s);
}

/**
 * Extract output file paths from a step output value.
 *
 * Handles:
 * - `[{ path, size }]`        (local/save-json)
 * - `[{ file, rows }]`        (local/radar-report)
 * - `{ path: '...' }`         (single-file objects)
 * - a plain path string       (./out/x.json)
 *
 * Returns deduplicated paths, order preserved. Empty when nothing looks like
 * a path.
 */
export function extractOutputPaths(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  const out: string[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const p = (item as Record<string, unknown>).path;
        const f = (item as Record<string, unknown>).file;
        const candidate = typeof p === 'string' ? p : typeof f === 'string' ? f : null;
        if (candidate) out.push(candidate);
      }
    }
  } else if (typeof value === 'string') {
    if (looksLikePath(value)) out.push(value);
  } else if (typeof value === 'object') {
    const p = (value as Record<string, unknown>).path;
    if (typeof p === 'string') out.push(p);
  }

  // Dedupe, preserve order
  return [...new Set(out)];
}

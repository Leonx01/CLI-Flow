/**
 * Client-side helper: ask the local server to reveal an output file in the
 * OS file manager (Explorer / Finder). The server runs on the same machine
 * as the files, so a POST to /api/open-output spawns the file manager.
 */

export function openOutput(filePath: string): void {
  fetch('/api/open-output', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  }).catch(() => {
    // Server unreachable or handler failed — nothing useful to do in the UI.
  });
}

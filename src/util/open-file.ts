/**
 * Open a file in the OS file manager — NODE-ONLY module (imports Node
 * built-ins). Used by the TUI ('o' key) and the web server
 * (/api/open-output). Do NOT import from browser code.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

function toAbsolute(p: string): string {
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * Reveal a file in the OS file manager (like "Show in Finder" / "Show in
 * Explorer"). Rejects when the file doesn't exist.
 */
export async function openInFileManager(filePath: string): Promise<void> {
  const abs = toAbsolute(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }

  const dir = path.dirname(abs);

  if (process.platform === 'win32') {
    // `explorer /select,<path>` — explorer returns exit code 1 even on
    // success, so don't treat a non-zero exit as failure.
    execFile('explorer', ['/select,', abs]);
  } else if (process.platform === 'darwin') {
    await execFileP('open', ['-R', abs]);
  } else {
    await execFileP('xdg-open', [dir]);
  }
}

function execFileP(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  });
}

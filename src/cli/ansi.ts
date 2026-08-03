/**
 * Shared ANSI palette for workflow-facing terminal output (`workflow run`'s
 * live tree, plus `preflight`/`trace`/`validate`/`dry-run`'s static reports).
 * One definition so "green" means the same escape code everywhere.
 */
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[95m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  moveUp: (n: number) => `\x1b[${n}A`,
};

export function colorize(color: keyof typeof ANSI, text: string): string {
  const code = ANSI[color];
  return typeof code === 'string' ? `${code}${text}${ANSI.reset}` : text;
}

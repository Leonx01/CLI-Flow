/**
 * Error classification and typed error classes for the workflow engine.
 *
 * Extracted from engine.ts to isolate error handling logic and enable
 * independent unit testing.
 */

import { AuthRequiredError } from '@jackwener/opencli/errors';

// ── Error types ─────────────────────────────────────────────────────────────

export type ErrorCategory = 'transient' | 'config' | 'auth' | 'adapter';

export class StepSkippedError extends Error {
  readonly reason?: string;
  constructor(stepName: string, reason?: string) {
    super(reason ? `Step "${stepName}" skipped: ${reason}` : `Step "${stepName}" skipped by interaction`);
    this.name = 'StepSkippedError';
    this.reason = reason;
  }
}

export class AuthAbortedError extends Error {
  constructor(site: string) {
    super(`Workflow aborted by user (auth required for ${site})`);
    this.name = 'AuthAbortedError';
  }
}

// ── Classification functions ────────────────────────────────────────────────

/**
 * Duck-type check for AuthRequiredError across module boundaries.
 * Adapters import from '@jackwener/opencli/errors' (dist/), engine from
 * '../errors.js' (src/). instanceof fails cross-module, so we check the
 * error code property as well.
 */
export function isAuthRequiredError(err: unknown): err is AuthRequiredError {
  if (err instanceof AuthRequiredError) return true;
  if (err instanceof Error && 'code' in err && (err as any).code === 'AUTH_REQUIRED') return true;
  return false;
}

/**
 * Classify an error by its CliError.code property to determine retry and
 * error-policy behavior. Uses structured code checks only — no message
 * string matching.
 */
export function classifyError(err: unknown): ErrorCategory {
  if (isAuthRequiredError(err)) return 'auth';

  if (err instanceof Error && 'code' in err) {
    const code = (err as any).code as string;
    if (['TIMEOUT', 'SESSION_BUSY', 'BROWSER_CONNECT'].includes(code)) return 'transient';
    if (['CONFIG', 'ARGUMENT', 'ADAPTER_LOAD'].includes(code)) return 'config';
    if (code === 'LOGIN_WALL') return 'auth';
  }

  return 'adapter';
}

/**
 * Check whether an error indicates a browser/daemon connection failure.
 * Uses CliError.code only — no message string matching.
 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ('code' in err) {
    const code = (err as any).code as string;
    return code === 'BROWSER_CONNECT' || code === 'SESSION_BUSY';
  }
  return false;
}

/**
 * Extract a human-readable message from an error, including its cause chain.
 */
export function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let msg = err.message;
  let cause = (err as any).cause;
  while (cause) {
    if (cause instanceof Error) {
      msg += `: ${cause.message}`;
      cause = (cause as any).cause;
    } else {
      msg += `: ${String(cause)}`;
      break;
    }
  }
  return msg;
}

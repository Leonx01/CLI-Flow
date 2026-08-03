/**
 * Auth retry logic for workflow steps that require browser authentication.
 *
 * Extracted from engine.ts to isolate the auth interaction flow
 * (passive retry, serialized auth queue, browser-open fallback).
 */

import { log } from '../util/utils.js';
import {
  isAuthRequiredError,
  isConnectionError,
  StepSkippedError,
  AuthAbortedError,
} from './error-classify.js';
import { getLocale } from '../util/locale.js';
import type {
  WorkflowStep,
  WorkflowCallbacks,
  ResolvedInteractSpec,
  AdapterExecMeta,
  TraceEvent,
} from '../schema/types.js';

// ── Auth interaction serialization queue ────────────────────────────────────

export interface AuthQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
}

export function createAuthQueue(): AuthQueue {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(fn, fn);
      chain = next.catch(() => {});
      return next;
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

interface InvokeResult {
  data: unknown;
  meta: AdapterExecMeta;
}

export async function executeWithAuthRetry(
  step: WorkflowStep,
  site: string,
  args: Record<string, unknown>,
  debug: boolean,
  callbacks: WorkflowCallbacks | undefined,
  stepName: string,
  authedSites: Set<string>,
  invokeAdapter: (adapterName: string, args: Record<string, unknown>, debug: boolean) => Promise<InvokeResult>,
  authQueue: AuthQueue,
  abortSignal?: AbortSignal,
  onTraceEvent?: WorkflowCallbacks['onTraceEvent'],
): Promise<InvokeResult> {
  const authCfg = typeof step.auth === 'object' ? step.auth : {};
  const timeout = authCfg.timeout ?? 120;
  const onTimeout = authCfg.on_timeout ?? 'skip';
  const maxRetries = authCfg.max_retries ?? 1;

  if (authedSites.has(site)) {
    try {
      return await invokeAdapter(step.adapter!, args, debug);
    } catch (err) {
      if (isAuthRequiredError(err)) {
        authedSites.delete(site);
      } else {
        throw err;
      }
    }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const invokeResult = await invokeAdapter(step.adapter!, args, debug);
      authedSites.add(site);
      return invokeResult;
    } catch (err) {
      if (!isAuthRequiredError(err) && !isConnectionError(err)) throw err;

      const authResult = await triggerAuthInteraction(site, timeout, onTimeout, callbacks, stepName, step.adapter!, debug, authedSites, authQueue, abortSignal, onTraceEvent, attempt);
      if (authResult === 'skipped') {
        throw new StepSkippedError(stepName, `auth required for ${site}`);
      } else if (authResult === 'aborted') {
        throw new AuthAbortedError(site);
      }
    }
  }

  throw new StepSkippedError(stepName, `auth failed after ${maxRetries + 1} attempts for ${site}`);
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<T | '__timeout__' | '__aborted__'> {
  let timer: ReturnType<typeof setTimeout>;
  let abortHandler: (() => void) | undefined;
  const promises: Promise<T | '__timeout__' | '__aborted__'>[] = [
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve('__timeout__'), timeoutMs); }),
  ];
  if (abortSignal) {
    promises.push(new Promise<'__aborted__'>(resolve => {
      if (abortSignal.aborted) { resolve('__aborted__'); return; }
      abortHandler = () => resolve('__aborted__');
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }));
  }
  return Promise.race(promises).finally(() => {
    clearTimeout(timer!);
    if (abortHandler && abortSignal && !abortSignal.aborted) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  });
}

async function triggerAuthInteraction(
  site: string,
  timeout: number,
  onTimeout: 'skip' | 'abort',
  callbacks: WorkflowCallbacks | undefined,
  stepName: string,
  adapterName: string,
  debug: boolean,
  authedSites: Set<string>,
  authQueue: AuthQueue,
  abortSignal?: AbortSignal,
  onTraceEvent?: WorkflowCallbacks['onTraceEvent'],
  attempt?: number,
): Promise<'ready' | 'skipped' | 'aborted'> {
  return authQueue.enqueue(async () => {
    if (authedSites.has(site)) return 'ready';

    onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_trigger', spanId: `auth-${site}-${attempt}`, detail: { site, timeout } });
    const spec: ResolvedInteractSpec = {
      type: 'auth',
      message: getLocale().auth_needs_login(site),
      site,
      timeout,
    };

    if (!callbacks?.onInteract) {
      log.warn(`${site} requires login but no interactive terminal available — step skipped. Use --auto-approve to auto-skip silently.`);
      onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_result', spanId: `auth-${site}-${attempt}`, detail: { site, result: 'skipped' } });
      return 'skipped';
    }

    const answer = await raceWithAbort(
      callbacks.onInteract(stepName, spec),
      timeout * 1000,
      abortSignal,
    );

    if (answer === '__aborted__') {
      onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_result', spanId: `auth-${site}-${attempt}`, detail: { site, result: 'aborted' } });
      return 'aborted';
    }

    if (answer === 'login') {
      const opened = await openBrowserForLogin(adapterName, site, debug);
      const confirmSpec: ResolvedInteractSpec = {
        type: 'confirm',
        message: opened
          ? getLocale().auth_browser_opened(site)
          : `Could not open browser for ${site}. Is the browser running? Press Enter to retry, or skip this step.`,
      };
      const confirmAnswer = await raceWithAbort(
        callbacks.onInteract(stepName, confirmSpec),
        30_000,
        abortSignal,
      );
      if (confirmAnswer === '__aborted__') {
        onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_result', spanId: `auth-${site}-${attempt}`, detail: { site, result: 'aborted' } });
        return 'aborted';
      }
      onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_result', spanId: `auth-${site}-${attempt}`, detail: { site, result: 'ready' } });
      return 'ready';
    } else if (answer === 'skip' || answer === '__timeout__') {
      if (answer === '__timeout__' && onTimeout === 'abort') {
        onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_result', spanId: `auth-${site}-${attempt}`, detail: { site, result: 'aborted' } });
        return 'aborted';
      }
      onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_result', spanId: `auth-${site}-${attempt}`, detail: { site, result: 'skipped' } });
      return 'skipped';
    } else {
      onTraceEvent?.(stepName, { ts: Date.now(), type: 'auth_result', spanId: `auth-${site}-${attempt}`, detail: { site, result: 'aborted' } });
      return 'aborted';
    }
  });
}

async function openBrowserForLogin(
  adapterName: string,
  site: string,
  debug: boolean,
): Promise<boolean> {
  let domain = `${site}.com`;
  try {
    const { getRegistry } = await import('@jackwener/opencli/registry');
    const registry = getRegistry();
    const cmd = registry.get(adapterName);
    if (cmd?.domain) {
      domain = cmd.domain;
    } else if (debug) {
      log.info?.(`  No domain registered for ${adapterName}, using fallback: ${domain}`);
    }
  } catch { /* use fallback */ }

  const url = `https://${domain}`;

  try {
    // @ts-ignore — opencli internal, dynamic import with fallback
    const { sendCommand } = await import('@jackwener/opencli/browser/daemon-client' as string);
    await sendCommand('navigate', { url });
    return true;
  } catch {
    // daemon not connected, fallback to system browser
  }

  try {
    const { execFile } = await import('node:child_process');
    const { platform } = await import('node:os');
    const openCmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
    execFile(openCmd, [url]);
    return true;
  } catch {
    if (debug) {
      log.info?.(`  Could not auto-open browser for ${site}`);
    }
    return false;
  }
}

/**
 * Workflow engine: DAG-based execution of multi-step workflows.
 */

import * as path from 'node:path';
import { log } from '../util/utils.js';
import { mapConcurrent, sleep } from '../util/utils.js';
import { getRegistry } from '@jackwener/opencli/registry';
// @ts-ignore — needs fork to export this path
import { executeCommand } from '@jackwener/opencli/execution';

import { DAGScheduler, CycleError } from './scheduler.js';
import { WorkflowContext } from './context.js';
import { parseWorkflow } from '../schema/parser.js';
import {
  generateRunId,
  saveCheckpoint,
  loadCheckpoint,
  hashDefinition,
} from './checkpoint.js';
import {
  isAuthRequiredError,
  classifyError,
  extractErrorMessage,
  StepSkippedError,
  AuthAbortedError,
} from './error-classify.js';
import { InteractPauseSignal } from './interact.js';
import { applyOutputMap } from './output-map.js';
import { executeWithAuthRetry, createAuthQueue } from './auth-retry.js';
import type { AuthQueue } from './auth-retry.js';

function shouldUseBrowserSession(cmd: { strategy?: string; browser?: boolean }): boolean {
  const s = cmd.strategy?.toUpperCase();
  return s === 'COOKIE' || s === 'UI' || s === 'INTERCEPT' || !!cmd.browser;
}
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowRunResult,
  WorkflowCallbacks,
  StepRecord,
  ResolvedInteractSpec,
  SkipReason,
  TraceErrorType,
  AdapterExecMeta,
  DataFlowRecord,
  TerminationReason,
  PendingInteract,
} from '../schema/types.js';
import { generateValuePreview } from '../trace/trace.js';

const MAX_NESTING_DEPTH = 5;

export interface WorkflowOptions {
  debug?: boolean;
  resumeRunId?: string;
  dryRun?: boolean;
  callbacks?: WorkflowCallbacks;
  /** Suppress the routine start/end banner logs (a live renderer already shows this). */
  quiet?: boolean;
  /** Interact answers to inject when resuming a paused workflow (agent-mode): stepName -> answer. */
  interactAnswer?: Record<string, unknown>;
  /** @internal Nesting depth counter, auto-propagated by the engine. */
  _nestingDepth?: number;
  /** @internal Visited workflow paths for circular reference detection. */
  _visitedPaths?: Set<string>;
  /** @internal AbortSignal for cooperative cancellation across nested workflows. */
  _abortSignal?: AbortSignal;
  /** @internal Shared set of already-authenticated sites, propagated to nested workflows. */
  _authedSites?: Set<string>;
  /** @internal Shared auth interaction serialization queue, propagated to nested workflows. */
  _authQueue?: AuthQueue;
}

/**
 * Validate required workflow inputs before execution.
 * Call this before starting TUI to fail fast on missing inputs.
 */
export function validateWorkflowInputs(
  definition: WorkflowDefinition,
  inputArgs?: Record<string, unknown>,
): void {
  if (!definition.inputs) return;
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(definition.inputs)) {
    if (spec.required && !(inputArgs && name in inputArgs) && spec.default === undefined) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Workflow "${definition.name}" requires missing input(s): ${missing.join(', ')}\n` +
      `Provide via: --input ${missing.map(m => `${m}=<value>`).join(' ')}`
    );
  }
}

export async function executeWorkflow(
  definition: WorkflowDefinition,
  inputArgs?: Record<string, unknown>,
  options?: WorkflowOptions,
): Promise<WorkflowRunResult> {
  const debug = options?.debug ?? false;
  const quiet = options?.quiet ?? false;
  const startedAt = Date.now();
  const nestingDepth = options?._nestingDepth ?? 0;
  const visitedPaths = options?._visitedPaths;

  if (nestingDepth > MAX_NESTING_DEPTH) {
    throw new Error(`Workflow nesting depth exceeds ${MAX_NESTING_DEPTH} — possible infinite recursion`);
  }

  // Initialize context
  let context: WorkflowContext;
  let completedSteps: Set<string>;
  let runId: string;

  if (options?.resumeRunId) {
    const checkpoint = loadCheckpoint(options.resumeRunId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${options.resumeRunId}`);
    }
    context = WorkflowContext.fromJSON(checkpoint.context);
    completedSteps = new Set(checkpoint.completedSteps);
    runId = checkpoint.runId;
    if (checkpoint.definitionHash) {
      const currentHash = hashDefinition(definition);
      if (checkpoint.definitionHash !== currentHash) {
        log.warn?.(
          `Workflow definition has changed since checkpoint was saved. ` +
          `Resume may produce unexpected results. Consider starting fresh.`
        );
      }
    }
    // If resuming from paused interacts with answers, inject them as a one-shot handler.
    // A single resume call can answer all currently-pending interacts at once.
    if (checkpoint.pendingInteracts?.length && options.interactAnswer) {
      const answers = options.interactAnswer;
      const consumed = new Set<string>();
      const originalOnInteract = options.callbacks?.onInteract;
      if (options.callbacks) {
        options.callbacks = {
          ...options.callbacks,
          onInteract(stepName, spec) {
            if (!consumed.has(stepName) && Object.prototype.hasOwnProperty.call(answers, stepName)) {
              consumed.add(stepName);
              return Promise.resolve(answers[stepName]);
            }
            return originalOnInteract ? originalOnInteract(stepName, spec) : Promise.resolve(undefined);
          },
        };
      }
    }
    log.info?.(`Resuming workflow "${definition.name}" from checkpoint (${completedSteps.size} steps completed)`);
  } else {
    context = new WorkflowContext();
    completedSteps = new Set<string>();
    runId = generateRunId();

    if (inputArgs) {
      for (const [key, value] of Object.entries(inputArgs)) {
        context.set(key, value);
      }
    }

    // Apply defaults first, then validate required inputs
    if (definition.inputs) {
      for (const [name, spec] of Object.entries(definition.inputs)) {
        if (!context.has(name) && spec.default !== undefined) {
          context.set(name, spec.default);
        }
      }
      for (const [name, spec] of Object.entries(definition.inputs)) {
        if (spec.required && !context.has(name)) {
          throw new Error(`Workflow "${definition.name}" requires input "${name}"`);
        }
      }
    }
  }

  // Build and validate DAG
  const scheduler = new DAGScheduler(definition.steps);
  const validation = scheduler.validate();
  if (!validation.valid) {
    throw new CycleError(validation.cycle!);
  }

  // Dry run: show execution plan
  if (options?.dryRun) {
    const waves = scheduler.plan();
    return {
      id: runId,
      workflow: definition.name,
      status: 'completed',
      completedSteps: [],
      failedSteps: [],
      skippedSteps: [],
      context: { executionPlan: waves },
      startedAt,
      finishedAt: Date.now(),
      stepRecords: [],
    };
  }

  const authedSites = options?._authedSites ?? new Set<string>();
  const authQueue = options?._authQueue ?? createAuthQueue();
  const failedSteps = new Set<string>();
  const skippedSteps = new Set<string>();
  const blockedOnInteract = new Map<string, ResolvedInteractSpec>();
  const stepRecords: StepRecord[] = [];
  const dataFlowMap = new Map<string, DataFlowRecord>();
  let terminationReason: TerminationReason | undefined;
  const totalSteps = Object.keys(definition.steps).length;
  const defaultErrorPolicy = definition.on_error ?? 'stop';
  const maxParallel = definition.max_parallel ?? 10;
  const deadline = startedAt + (definition.timeout ?? 1800) * 1000;
  const callbacks = options?.callbacks;

  if (!quiet) log.info?.(`Starting workflow "${definition.name}" (${totalSteps} steps, run: ${runId})`);
  callbacks?.onWorkflowStart?.({
    runId,
    workflow: definition.name,
    totalSteps,
    startedAt,
    definitionHash: hashDefinition(definition),
    inputs: inputArgs,
  });

  // Cooperative cancellation via AbortController.
  // Only the top-level workflow registers a SIGINT handler; nested workflows
  // receive the signal through the parent's AbortController cascade.
  const ac = new AbortController();
  const parentSignal = options?._abortSignal;
  const parentAbortHandler = parentSignal ? () => ac.abort() : undefined;
  if (parentSignal) {
    if (parentSignal.aborted) ac.abort();
    else parentSignal.addEventListener('abort', parentAbortHandler!, { once: true });
  }

  let existingListeners: Function[] = [];
  let sigintCount = 0;
  if (nestingDepth === 0) {
    existingListeners = process.listeners('SIGINT').slice();
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => {
      sigintCount++;
      if (sigintCount === 1) {
        ac.abort();
        terminationReason = 'sigint';
        wakeup?.();
        if (!quiet) log.info?.(`Workflow "${definition.name}" received SIGINT, finishing current steps... (press Ctrl+C again to force exit)`);
      } else {
        const runningSteps = [...running.keys()];
        process.stderr.write(`\nForce exit — workflow "${definition.name}" killed.\n`);
        if (runningSteps.length > 0) {
          process.stderr.write(`Stuck steps: ${runningSteps.join(', ')}\n`);
        }
        process.stderr.write(new Error('Force exit trace').stack + '\n');
        process.exit(130);
      }
    });
  }

  // DAG execution loop
  let shouldStop = false;
  const running = new Map<string, Promise<void>>();
  let wakeup: (() => void) | null = null;

  try {
    // Event-driven DAG execution: each completing step immediately
    // triggers its newly-unblocked dependents instead of waiting
    // for the whole wave to finish.

    function launchStep(stepName: string): void {
      const promise = (async () => {
        const step = definition.steps[stepName];
        const errorPolicy = step.on_error ?? defaultErrorPolicy;
        const stepStartedAt = Date.now();
        callbacks?.onStepStart?.({ stepName, step, description: step.description, startedAt: stepStartedAt });

        // Track data flow: record which variables this step consumes
        const referencedVars = extractVarRefs(step);
        for (const varRef of referencedVars) {
          const record = dataFlowMap.get(varRef);
          if (record && !record.consumers.includes(stepName)) {
            record.consumers.push(stepName);
          }
        }

        // Persist a checkpoint after any step that reaches a terminal *success*
        // state (first attempt or retry). Skipped/failed terminal states don't
        // advance completedSteps meaningfully for resume and stay uncached here.
        const persistCheckpoint = (): void => {
          if (!definition.checkpoint) return;
          try {
            saveCheckpoint({
              workflowName: definition.name,
              runId,
              completedSteps: [...completedSteps],
              context: context.toJSON(),
              startedAt,
              updatedAt: Date.now(),
              definitionHash: hashDefinition(definition),
            });
          } catch (cpErr) {
            log.warn?.(`  checkpoint write failed: ${cpErr instanceof Error ? cpErr.message : cpErr}`);
          }
        };

        const finish = (
          record: StepRecord,
          endStatus: StepRecord['status'],
          error?: string,
          foreachErrors?: string[],
          resolvedArgs?: Record<string, unknown>,
          output?: { varName: string; value: unknown },
          traceExtra?: {
            skipReason?: SkipReason;
            missingVars?: string[];
            errorType?: TraceErrorType;
            errorCause?: Array<{ message: string; type?: string }>;
            condition?: { expression: string; resolved: unknown };
            foreachSource?: { expression: string; itemCount: number };
            nestedRunId?: string;
            adapterExec?: AdapterExecMeta;
          },
        ) => {
          const finishedAt = Date.now();
          record.finishedAt = finishedAt;
          record.durationMs = finishedAt - record.startedAt!;
          record.status = endStatus;
          record.error = error;
          record.foreachErrors = foreachErrors;
          stepRecords.push(record);

          if (output) {
            const existing = dataFlowMap.get(output.varName);
            if (!existing) {
              dataFlowMap.set(output.varName, {
                varName: output.varName,
                producer: stepName,
                consumers: [],
                valuePreview: generateValuePreview(output.value),
                itemCount: Array.isArray(output.value) ? output.value.length : undefined,
              });
            }
          }

          callbacks?.onStepEnd?.({
            stepName,
            step,
            description: step.description,
            startedAt: record.startedAt!,
            finishedAt,
            durationMs: record.durationMs,
            status: endStatus,
            error,
            foreachErrors,
            resolvedArgs,
            output,
            skipReason: traceExtra?.skipReason,
            missingVars: traceExtra?.missingVars,
            errorType: traceExtra?.errorType,
            errorCause: traceExtra?.errorCause,
            condition: traceExtra?.condition,
            foreachSource: traceExtra?.foreachSource,
            nestedRunId: traceExtra?.nestedRunId,
            adapterExec: traceExtra?.adapterExec,
          });
        };

        // For browser adapter steps with auth, ensure step timeout is at least
        // auth timeout + 30s so the auth interaction has enough time to complete
        // before the step timeout kills it.
        let effectiveTimeoutSec = step.timeout ?? 300;
        if (step.auth && step.adapter) {
          const authCfg = typeof step.auth === 'object' ? step.auth : {};
          const authTimeout = authCfg.timeout ?? 120;
          if (_adapterNeedsBrowser(step.adapter)) {
            effectiveTimeoutSec = Math.max(effectiveTimeoutSec, authTimeout + 30);
          }
        }

        try {
          const stepTimeout = effectiveTimeoutSec * 1000;
          let timer: ReturnType<typeof setTimeout>;
          const stepResult = await Promise.race([
            _executeStep(stepName, step, context, debug, callbacks, authedSites, nestingDepth, visitedPaths, ac.signal, authQueue),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'step_timeout', detail: { timeoutSec: effectiveTimeoutSec } });
                  reject(new Error(`Step "${stepName}" timed out after ${effectiveTimeoutSec}s`));
                },
                stepTimeout,
              );
            }),
          ]).finally(() => clearTimeout(timer!));

          // Check if step was skipped (condition false)
          if (stepResult && 'skipped' in stepResult && stepResult.skipped) {
            skippedSteps.add(stepName);
            completedSteps.add(stepName);
            callbacks?.onStepSkipped?.({ stepName, reason: 'condition_false', ts: Date.now() });
            finish({ name: stepName, status: 'skipped', startedAt: stepStartedAt }, 'skipped', stepResult.skipReason, undefined, undefined, undefined, {
              skipReason: 'condition_false',
              condition: stepResult.conditionTrace,
            });
            persistCheckpoint();
            return;
          }

          completedSteps.add(stepName);
          finish(
            { name: stepName, status: 'completed', startedAt: stepStartedAt },
            'completed',
            undefined,
            stepResult?.foreachErrors,
            stepResult?.resolvedArgs,
            stepResult?.output,
            {
              condition: stepResult?.conditionTrace,
              foreachSource: stepResult?.foreachSourceTrace,
              nestedRunId: stepResult?.nestedRunId,
              adapterExec: stepResult?.adapterExecMeta,
            },
          );

          if (debug) {
            log.info?.(`  completed: ${stepName}`);
          }

          // Checkpoint after each step
          persistCheckpoint();
        } catch (err) {
          // Agent-mode: InteractPauseSignal means this step can't proceed without a
          // decision. Collect it (don't stop the workflow yet) — other independent
          // ready steps in the same wave may also be running and should get a chance
          // to surface their own pending interacts before we declare a pause. The
          // workflow is only truly "paused" once nothing more can run (see the main
          // wave loop below), at which point all collected interacts are reported
          // and checkpointed together in one shot.
          if (err instanceof InteractPauseSignal) {
            blockedOnInteract.set(err.stepName, err.spec);
            finish(
              { name: stepName, status: 'skipped', startedAt: stepStartedAt },
              'skipped',
              'Waiting for interact decision',
              undefined, undefined, undefined,
              { skipReason: 'interact_pending' },
            );
            return;
          }

          // Collect error cause chain for diagnostics
          const causePath: Array<{ message: string; type?: string }> = [];
          let current: unknown = err;
          while (current instanceof Error) {
            causePath.push({ message: current.message, type: current.constructor.name });
            current = (current as any).cause;
          }

          // Classify error type
          let errorType: TraceErrorType = 'GenericError';
          if (err instanceof StepSkippedError) errorType = 'StepSkippedError';
          else if (err instanceof AuthAbortedError) errorType = 'AuthAbortedError';
          else if (isAuthRequiredError(err)) errorType = 'AuthRequiredError';
          else if (
            (err instanceof Error && 'code' in err && (err as any).code === 'TIMEOUT') ||
            (err instanceof Error && err.message.startsWith('Step "') && err.message.includes('timed out'))
          ) errorType = 'TimeoutError';

          if (err instanceof StepSkippedError) {
            skippedSteps.add(stepName);
            completedSteps.add(stepName);
            // Determine skip reason from StepSkippedError context
            let skipReason: SkipReason = 'dependency_failed';
            let missingVars: string[] | undefined;
            if (err.reason?.includes('dependency output not available')) {
              skipReason = 'missing_var';
              // Extract variable names from reason string
              const match = err.reason.match(/dependency output not available: (.+)/);
              if (match) missingVars = match[1].split(', ');
            } else if (err.reason?.includes('auth')) {
              skipReason = 'auth_skipped';
            }
            callbacks?.onStepSkipped?.({ stepName, reason: skipReason, missingVars, ts: Date.now() });
            finish({ name: stepName, status: 'skipped', startedAt: stepStartedAt }, 'skipped', err.reason, undefined, undefined, undefined, { skipReason, missingVars, errorType, errorCause: causePath });
            return;
          }

          // Auth aborted by user — always treat as hard failure, ignore on_error: skip
          if (err instanceof AuthAbortedError) {
            const errMsg = extractErrorMessage(err);
            failedSteps.add(stepName);
            shouldStop = true;
            finish({ name: stepName, status: 'failed', startedAt: stepStartedAt }, 'failed', errMsg, undefined, undefined, undefined, { errorType, errorCause: causePath });
            return;
          }

          const errMsg = extractErrorMessage(err);
          if (!quiet) log.warn?.(`  ${stepName} failed: ${errMsg}`);

          // Classify error to determine retry behavior
          const errCategory = classifyError(err);

          // Determine effective retry count:
          // - config → 0 (never retry)
          // - transient → at least 1, even without explicit retry config
          // - adapter → follow user config only if on_error=retry
          const effectiveRetries = (() => {
            if (errCategory === 'config') return 0;
            if (errCategory === 'auth') return 0; // auth has its own flow
            if (errCategory === 'transient') return Math.max(step.retries ?? 0, 1);
            // adapter: only retry if user explicitly configured retry
            if (errorPolicy === 'retry') return step.retries ?? 1;
            return 0;
          })();

          if (effectiveRetries > 0) {
            const retries = effectiveRetries;
            const retryStepTimeout = effectiveTimeoutSec * 1000;
            let succeeded = false;
            let attemptsUsed = 0;
            let lastErrMsg = errMsg;
            let retryForeachErrors: string[] | undefined;
            let retryResolvedArgs: Record<string, unknown> | undefined;
            let retryOutput: { varName: string; value: unknown } | undefined;
            for (let attempt = 1; attempt <= retries; attempt++) {
              attemptsUsed = attempt;
              const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
              const jitter = Math.floor(Math.random() * backoff * 0.3);
              if (!quiet) log.info?.(`  ${stepName} retry ${attempt}/${retries} [${errCategory}] (backoff ${backoff + jitter}ms)`);
              callbacks?.onStepRetry?.({ stepName, step, description: step.description, attempt, maxRetries: retries, error: lastErrMsg });
              callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'retry_start', spanId: `retry-${attempt}`, detail: { attempt, maxRetries: retries, backoffMs: backoff + jitter } });
              await sleep(backoff + jitter, ac.signal).catch(() => {});
              if (ac.signal.aborted) break;
              try {
                let retryTimer: ReturnType<typeof setTimeout>;
                const retryResult = await Promise.race([
                  _executeStep(stepName, step, context, debug, callbacks, authedSites, nestingDepth, visitedPaths, ac.signal, authQueue),
                  new Promise<never>((_, reject) => {
                    retryTimer = setTimeout(
                      () => {
                        callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'step_timeout', spanId: `retry-${attempt}`, detail: { timeoutSec: effectiveTimeoutSec } });
                        reject(new Error(`Step "${stepName}" retry ${attempt} timed out after ${effectiveTimeoutSec}s`));
                      },
                      retryStepTimeout,
                    );
                  }),
                ]).finally(() => clearTimeout(retryTimer!));
                completedSteps.add(stepName);
                succeeded = true;
                callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'retry_result', spanId: `retry-${attempt}`, detail: { attempt, success: true } });
                retryForeachErrors = retryResult?.foreachErrors;
                retryResolvedArgs = retryResult?.resolvedArgs;
                retryOutput = retryResult?.output;
                break;
              } catch (retryErr) {
                lastErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'retry_result', spanId: `retry-${attempt}`, detail: { attempt, success: false, error: lastErrMsg } });
                // 如果重试中发现错误变为 config 类型，提前终止
                if (classifyError(retryErr) === 'config') {
                  if (!quiet) log.warn?.(`  ${stepName} retry ${attempt} failed (config error, stop retrying): ${lastErrMsg}`);
                  break;
                }
                if (!quiet) log.warn?.(`  ${stepName} retry ${attempt} failed: ${lastErrMsg}`);
              }
            }
            if (succeeded) {
              finish(
                { name: stepName, status: 'completed', startedAt: stepStartedAt, retries: attemptsUsed },
                'completed',
                undefined,
                retryForeachErrors,
                retryResolvedArgs,
                retryOutput,
              );
              persistCheckpoint();
            } else {
              failedSteps.add(stepName);
              shouldStop = true;
              finish({ name: stepName, status: 'failed', startedAt: stepStartedAt, retries: attemptsUsed }, 'failed', lastErrMsg);
            }
          } else if (errorPolicy === 'skip') {
            skippedSteps.add(stepName);
            completedSteps.add(stepName);
            callbacks?.onStepSkipped?.({ stepName, reason: 'on_error_skip', ts: Date.now() });
            finish({ name: stepName, status: 'skipped', startedAt: stepStartedAt }, 'skipped', errMsg, undefined, undefined, undefined, { skipReason: 'on_error_skip', errorType, errorCause: causePath });
          } else {
            failedSteps.add(stepName);
            shouldStop = true;
            finish({ name: stepName, status: 'failed', startedAt: stepStartedAt }, 'failed', errMsg, undefined, undefined, undefined, { errorType, errorCause: causePath });
          }
        }
      })().finally(() => {
        running.delete(stepName);
        wakeup?.();
      });

      running.set(stepName, promise);
    }

    while (!shouldStop && !ac.signal.aborted) {
      if (Date.now() > deadline) {
        log.warn?.(`Workflow "${definition.name}" timed out`);
        terminationReason = 'deadline';
        shouldStop = true;
        break;
      }

      const ready = scheduler.getReady(completedSteps, failedSteps)
        .filter(n => !skippedSteps.has(n) && !running.has(n) && !blockedOnInteract.has(n));

      for (const name of ready) {
        if (running.size >= maxParallel) break;
        launchStep(name);
      }

      if (running.size === 0) break;

      // Wait until at least one running step completes (or fails)
      await new Promise<void>(resolve => { wakeup = resolve; });
    }

    // Await any still-running steps before leaving the block.
    // After SIGINT, give running steps a grace period before moving on.
    if (ac.signal.aborted && running.size > 0) {
      const DRAIN_TIMEOUT_MS = 10_000;
      await Promise.race([
        Promise.allSettled([...running.values()]),
        sleep(DRAIN_TIMEOUT_MS).then(() => {
          log.warn?.(`${running.size} step(s) still running after ${DRAIN_TIMEOUT_MS / 1000}s grace period, moving on: ${[...running.keys()].join(', ')}`);
        }),
      ]);
    } else {
      await Promise.allSettled([...running.values()]);
    }
  } finally {
    if (parentSignal && parentAbortHandler && !parentSignal.aborted) {
      parentSignal.removeEventListener('abort', parentAbortHandler);
    }
    if (nestingDepth === 0) {
      process.removeAllListeners('SIGINT');
      for (const listener of existingListeners) {
        process.on('SIGINT', listener as (...args: unknown[]) => void);
      }
    }
  }

  // Agent-mode: if the wave loop stalled with nothing running and at least one
  // step blocked on an interact decision (and no hard failure interrupted us —
  // failedSteps is only ever populated alongside shouldStop=true, which would
  // have exited the loop via the while-condition instead of the natural
  // running.size===0 break), the workflow is genuinely paused. Collect ALL
  // currently-blocked interacts and checkpoint them together in one write —
  // this is the only place pendingInteracts gets persisted, eliminating the
  // race where concurrent steps used to each save their own single interact
  // and clobber each other's checkpoint write.
  let pendingInteracts: PendingInteract[] | undefined;
  if (!ac.signal.aborted && blockedOnInteract.size > 0 && failedSteps.size === 0) {
    terminationReason = 'paused';
    pendingInteracts = [...blockedOnInteract.entries()].map(([stepName, spec]) => ({ stepName, spec }));
    saveCheckpoint({
      workflowName: definition.name,
      runId,
      completedSteps: [...completedSteps],
      context: context.toJSON(),
      startedAt,
      updatedAt: Date.now(),
      definitionHash: hashDefinition(definition),
      pendingInteracts,
    });
  }

  // Save checkpoint on abort
  if (ac.signal.aborted && definition.checkpoint) {
    try {
      saveCheckpoint({
        workflowName: definition.name,
        runId,
        completedSteps: [...completedSteps],
        context: context.toJSON(),
        startedAt,
        updatedAt: Date.now(),
      });
      log.info?.(`Checkpoint saved for resume (run: ${runId})`);
    } catch (cpErr) {
      log.warn?.(`Checkpoint save on abort failed: ${cpErr instanceof Error ? cpErr.message : cpErr}`);
    }
  }

  const finishedAt = Date.now();
  const status = terminationReason === 'paused'
    ? 'paused'
    : ac.signal.aborted
      ? 'partial'
      : failedSteps.size > 0
        ? (completedSteps.size > 0 ? 'partial' : 'failed')
        : 'completed';

  if (!quiet) log.info?.(`Workflow "${definition.name}" ${status} in ${((finishedAt - startedAt) / 1000).toFixed(1)}s`);
  callbacks?.onWorkflowEnd?.({ runId, status, finishedAt });

  if (!terminationReason) {
    terminationReason = status === 'completed' ? 'completed' : (ac.signal.aborted ? 'aborted' : 'failed');
  }

  return {
    id: runId,
    workflow: definition.name,
    status,
    completedSteps: [...completedSteps],
    failedSteps: [...failedSteps],
    skippedSteps: [...skippedSteps],
    context: context.toJSON(),
    startedAt,
    finishedAt,
    error: failedSteps.size > 0 ? `Failed steps: ${[...failedSteps].join(', ')}` : undefined,
    stepRecords,
    terminationReason,
    dataFlow: [...dataFlowMap.values()],
    pendingInteracts,
  };
}

/**
 * Collect workflow variable names referenced by a step (args, foreach source,
 * interact.from) that are NOT yet present in the context. A referenced variable
 * being absent means the producing step was skipped/failed (it never `set` its
 * output) — the engine uses this to skip dependents cleanly instead of running
 * them with undefined inputs.
 */
function collectMissingVarRefs(step: WorkflowStep, context: WorkflowContext): string[] {
  const refs = new Set<string>();
  const collectDeep = (value: unknown) => {
    for (const name of context.extractVarRefsDeep(value)) refs.add(name);
  };
  if (step.foreach) collectDeep(step.foreach);
  if (step.args) collectDeep(step.args);
  if (step.condition) collectDeep(step.condition);
  if (step.interact && 'from' in step.interact && step.interact.from) collectDeep(step.interact.from);
  return [...refs].filter(name => !context.has(name));
}

function extractVarRefs(step: WorkflowStep): string[] {
  const refs = new Set<string>();
  const varPattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(varPattern)) {
        if (match[1] !== 'item' && match[1] !== 'index') refs.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(scan);
    }
  };
  if (step.args) scan(step.args);
  if (step.foreach) scan(step.foreach);
  if (step.interact && 'from' in step.interact) scan(step.interact.from);
  return [...refs];
}

async function _executeStep(
  stepName: string,
  step: WorkflowStep,
  context: WorkflowContext,
  debug: boolean,
  callbacks?: WorkflowCallbacks,
  authedSites?: Set<string>,
  nestingDepth = 0,
  visitedPaths?: Set<string>,
  abortSignal?: AbortSignal,
  authQueue?: AuthQueue,
): Promise<{
  skipped?: boolean;
  skipReason?: string;
  foreachErrors?: string[];
  resolvedArgs?: Record<string, unknown>;
  output?: { varName: string; value: unknown };
  conditionTrace?: { expression: string; resolved: unknown };
  foreachSourceTrace?: { expression: string; itemCount: number };
  nestedRunId?: string;
  adapterExecMeta?: AdapterExecMeta;
} | void> {
  let conditionTrace: { expression: string; resolved: unknown } | undefined;

  // Evaluate condition
  if (step.condition) {
    const condResult = context.resolve(step.condition);
    conditionTrace = { expression: step.condition, resolved: condResult };
    callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'condition_eval', detail: { expression: step.condition, resolved: condResult } });
    if (!condResult) {
      if (debug) log.info?.(`  ⊘ ${stepName} skipped (condition false)`);
      return { skipped: true, skipReason: 'condition false', conditionTrace };
    }
  }

  // Pre-launch precheck: if any workflow variable this step references hasn't
  // been produced yet, the producing step was skipped/failed — skip this step
  // cleanly instead of running its adapter/foreach with undefined inputs.
  // (Pure ordering `depends_on` that doesn't consume the dep's output still runs.)
  const missing = collectMissingVarRefs(step, context);
  if (missing.length) {
    throw new StepSkippedError(stepName, `dependency output not available: ${missing.join(', ')}`);
  }

  // Pure interaction node — produces output directly, no adapter call.
  // Includes select, multi-select, input, and confirm-without-adapter.
  const isPureInteract = step.interact
    && !step.adapter && !step.foreach && !step.workflow
    && !step.confirm;
  if (isPureInteract) {
    const output = await _handleInteractProduceOutput(stepName, step, context, callbacks);
    return { output };
  }

  // Confirmation gate — shorthand `confirm` or interact.type === 'confirm' before adapter
  if (step.confirm || step.interact?.type === 'confirm') {
    await _handleGateConfirm(stepName, step, callbacks);
  }

  const type = step.type ?? 'adapter';

  if (step.foreach) {
    // Resolve the iterable
    const iterableRef = step.foreach;
    const resolved = context.resolve(iterableRef);
    let iterable: unknown[];

    if (Array.isArray(resolved)) {
      iterable = resolved;
    } else if (resolved === null || resolved === undefined) {
      throw new Error(
        `Step "${stepName}" foreach references "${iterableRef}" which is not an array (got ${typeof resolved})`,
      );
    } else {
      // A single-select (or any upstream step whose output happens to collapse
      // to one value) legitimately produces a scalar instead of an array —
      // treat it as a length-1 list rather than hard-failing, so switching an
      // interact step between multi-select and select doesn't silently break
      // every downstream foreach.
      if (debug) {
        log.info?.(`  → ${stepName}: foreach source "${iterableRef}" resolved to a single value, treating as 1 item`);
      }
      iterable = [resolved];
    }

    const concurrency = step.concurrency ?? 1;
    const itemDelay = step.delay ?? 0;
    const foreachSourceTrace = { expression: iterableRef, itemCount: iterable.length };

    if (debug) {
      log.info?.(`  → ${stepName}: foreach ${iterable.length} items (concurrency: ${concurrency})`);
    }

    const errorPolicy = step.on_error ?? 'stop';
    const foreachTotal = iterable.length;
    let foreachCompleted = 0;
    let foreachFailed = 0;
    const foreachErrors: string[] = [];

    const results = await mapConcurrent(
      iterable,
      concurrency,
      async (item, index) => {
        try {
          let res: unknown;
          if (type === 'workflow') {
            const resolvedArgs = step.args
              ? context.resolveArgsTyped(step.args, item, index)
              : {};
            const nested = await _executeNestedWorkflow(step.workflow!, resolvedArgs, debug, stepName, callbacks, nestingDepth, visitedPaths, abortSignal, authedSites, authQueue);
            res = nested.context;
          } else {
            // Adapter step
            const resolvedArgs = step.args
              ? context.resolveArgs(step.args, item, index)
              : {};
            if (step.auth && authedSites) {
              const site = step.adapter!.split('/')[0];
              const authResult = await executeWithAuthRetry(step, site, resolvedArgs, debug, callbacks, stepName, authedSites, (a, r, d) => _invokeAdapter(a, r, d, abortSignal), authQueue!, abortSignal);
              res = authResult.data;
            } else {
              const invoked = await _invokeAdapter(step.adapter!, resolvedArgs, debug, abortSignal);
              res = invoked.data;
            }
          }
          foreachCompleted++;
          callbacks?.onForeachProgress?.({
            stepName, step, description: step.description,
            completed: foreachCompleted, total: foreachTotal, failed: foreachFailed,
          });
          return res;
        } catch (err) {
          if (errorPolicy === 'skip') {
            foreachCompleted++;
            foreachFailed++;
            const errMsg = extractErrorMessage(err);
            foreachErrors.push(`item ${index}: ${errMsg}`);
            callbacks?.onForeachProgress?.({
              stepName, step, description: step.description,
              completed: foreachCompleted, total: foreachTotal, failed: foreachFailed,
            });
            if (debug) {
              log.warn?.(`    foreach item ${index} failed (skipped): ${errMsg}`);
            }
            return _FOREACH_ITEM_FAILED;
          }
          throw err;
        } finally {
          // Paces each worker's own successive items — e.g. a slow/rate-limited
          // upstream (arxiv, etc.) that starts erroring under a burst of
          // concurrent requests. With concurrency>1 this throttles per-worker,
          // not globally, which is enough to keep request rate down.
          if (itemDelay > 0) await sleep(itemDelay, abortSignal).catch(() => {});
        }
      },
      abortSignal,
    );

    const successResults = results.filter(r => r !== _FOREACH_ITEM_FAILED);

    const shouldFlatten = step.flatten !== false;
    const flatResults = shouldFlatten ? successResults.flat() : successResults;
    if (debug && successResults.length < iterable.length) {
      log.info?.(`    ${iterable.length - successResults.length} items failed, ${successResults.length} succeeded`);
    }
    const { varName, mapped } = applyOutputMap(flatResults, step.output, stepName);
    context.set(varName, mapped);
    if (debug) {
      const count = Array.isArray(mapped) ? mapped.length : 1;
      log.info?.(`    output "${varName}": ${count} items`);
    }
    return { foreachErrors: foreachErrors.length > 0 ? foreachErrors : undefined, output: { varName, value: mapped }, conditionTrace, foreachSourceTrace };
  } else {
    // Single execution
    let result: unknown;
    let resolvedArgs: Record<string, unknown>;

    let nestedRunId: string | undefined;
    let adapterExecMeta: AdapterExecMeta | undefined;

    if (type === 'workflow') {
      resolvedArgs = step.args
        ? context.resolveArgsTyped(step.args)
        : {};
      const nested = await _executeNestedWorkflow(step.workflow!, resolvedArgs, debug, stepName, callbacks, nestingDepth, visitedPaths, abortSignal, authedSites, authQueue);
      result = nested.context;
      nestedRunId = nested.runId;
    } else {
      resolvedArgs = step.args
        ? context.resolveArgs(step.args)
        : {};
      if (debug) {
        const argSummary = Object.entries(resolvedArgs).map(([k, v]) => {
          const s = String(v);
          return `${k}=${s.length > 80 ? s.slice(0, 80) + '...' : s}`;
        }).join(', ');
        log.info?.(`    args: ${argSummary}`);
      }
      if (debug) log.info?.(`  auth check: step.auth=${step.auth}, authedSites=${!!authedSites}`);
      if (step.adapter && _adapterNeedsBrowser(step.adapter)) {
        await _ensureBrowserReady(stepName, step, callbacks);
      }
      const adapterSpanId = `adapter-0`;
      callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'adapter_invoke', spanId: adapterSpanId, detail: { adapter: step.adapter } });
      try {
        if (step.auth && authedSites) {
          const site = step.adapter!.split('/')[0];
          const authResult = await executeWithAuthRetry(step, site, resolvedArgs, debug, callbacks, stepName, authedSites, (a, r, d) => _invokeAdapter(a, r, d, abortSignal), authQueue!, abortSignal, callbacks?.onTraceEvent);
          result = authResult.data;
          adapterExecMeta = authResult.meta;
        } else {
          const invoked = await _invokeAdapter(step.adapter!, resolvedArgs, debug, abortSignal);
          result = invoked.data;
          adapterExecMeta = invoked.meta;
        }
        callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'adapter_result', spanId: adapterSpanId, detail: { adapter: step.adapter, durationMs: adapterExecMeta?.durationMs, itemCount: adapterExecMeta?.resultItemCount } });
      } catch (adapterErr) {
        callbacks?.onTraceEvent?.(stepName, { ts: Date.now(), type: 'adapter_error', spanId: adapterSpanId, detail: { adapter: step.adapter, error: adapterErr instanceof Error ? adapterErr.message : String(adapterErr) } });
        throw adapterErr;
      }
    }

    const { varName, mapped } = applyOutputMap(result, step.output, stepName);
    context.set(varName, mapped);
    if (debug) {
      log.info?.(`    output "${varName}": ${Array.isArray(mapped) ? mapped.length + ' items' : typeof mapped}`);
    }
    return { resolvedArgs, output: { varName, value: mapped }, conditionTrace, nestedRunId, adapterExecMeta };
  }
}

async function _handleGateConfirm(
  stepName: string,
  step: WorkflowStep,
  callbacks?: WorkflowCallbacks,
): Promise<void> {
  const message = typeof step.confirm === 'string'
    ? step.confirm
    : (step.interact?.type === 'confirm' && step.interact.message)
      ? step.interact.message
      : `Proceed with step "${stepName}"?`;

  const spec: ResolvedInteractSpec = { type: 'confirm', message };

  callbacks?.onInteractStart?.({ stepName, spec, ts: Date.now() });
  const t0 = Date.now();

  const approved = callbacks?.onInteract
    ? Boolean(await callbacks.onInteract(stepName, spec))
    : true;

  callbacks?.onInteractEnd?.({ stepName, spec, result: approved, durationMs: Date.now() - t0, ts: Date.now(), autoResolved: !callbacks?.onInteract });

  if (!approved) {
    throw new StepSkippedError(stepName);
  }
}

async function _handleInteractProduceOutput(
  stepName: string,
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks?: WorkflowCallbacks,
): Promise<{ varName: string; value: unknown }> {
  const interact = step.interact!;
  let spec: ResolvedInteractSpec;
  let fallbackValue: unknown;

  if (interact.type === 'select' || interact.type === 'multi-select') {
    const items = context.resolve(interact.from);
    if (!Array.isArray(items)) {
      throw new Error(`Step "${stepName}" interact.from references "${interact.from}" which is not an array (got ${typeof items})`);
    }
    if (items.length === 0) {
      throw new Error(`Step "${stepName}" interact.from resolved to an empty array — cannot present a ${interact.type} with no options`);
    }
    const options = items.map(item => ({
      label: interact.display && item && typeof item === 'object'
        ? String((item as Record<string, unknown>)[interact.display])
        : String(item),
      value: item,
    }));
    if (interact.type === 'select') {
      const selIdx = typeof interact.default === 'number' ? interact.default : 0;
      const selVal = options[selIdx]?.value ?? options[0]?.value;
      spec = { type: 'select', message: interact.message, options, defaultValue: selVal };
      fallbackValue = selVal;
    } else {
      // multi-select
      const idxs = Array.isArray(interact.default) ? interact.default : undefined;
      const defVals = idxs
        ? idxs.map(i => options[i]).filter(Boolean).map(o => o.value)
        : undefined;
      spec = { type: 'multi-select', message: interact.message, options, defaultValues: defVals };
      fallbackValue = defVals ?? options.map(o => o.value);
    }
  } else if (interact.type === 'input') {
    spec = { type: 'input', message: interact.message, default: interact.default };
    fallbackValue = interact.default ?? '';
  } else if (interact.type === 'confirm') {
    const message = interact.message || `Proceed with step "${stepName}"?`;
    const confDef = typeof interact.default === 'boolean' ? interact.default : undefined;
    spec = { type: 'confirm', message, defaultValue: confDef ?? true };
    fallbackValue = confDef ?? true;
  } else {
    throw new Error(`Step "${stepName}" interact.type "${(interact as any).type}" is not a pure output-producing interaction`);
  }

  callbacks?.onInteractStart?.({ stepName, spec, ts: Date.now() });
  const t0 = Date.now();

  const result = callbacks?.onInteract
    ? await callbacks.onInteract(stepName, spec)
    : fallbackValue;

  callbacks?.onInteractEnd?.({ stepName, spec, result, durationMs: Date.now() - t0, ts: Date.now(), autoResolved: !callbacks?.onInteract });

  const { varName, mapped } = applyOutputMap(result, step.output, stepName);
  context.set(varName, mapped);
  return { varName, value: mapped };
}

interface AdapterInvokeResult {
  data: unknown;
  meta: AdapterExecMeta;
}

async function _invokeAdapter(
  adapterName: string,
  args: Record<string, unknown>,
  debug: boolean,
  signal?: AbortSignal,
): Promise<AdapterInvokeResult> {
  const registry = getRegistry();
  const cmd = registry.get(adapterName);

  if (!cmd) {
    throw new Error(
      `Adapter "${adapterName}" not found in registry. ` +
      `Run "opencli list" to see available commands.`,
    );
  }

  const startedAt = Date.now();
  const commandPromise = executeCommand(cmd, args, debug);

  let result: unknown;
  if (signal) {
    let onAbort: (() => void) | undefined;
    result = await Promise.race([
      commandPromise,
      new Promise<never>((_, reject) => {
        if (signal.aborted) { reject(new Error('Aborted')); return; }
        onAbort = () => reject(new Error('Aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]).finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
  } else {
    result = await commandPromise;
  }

  return {
    data: result,
    meta: {
      adapter: adapterName,
      strategy: cmd.strategy,
      startedAt,
      durationMs: Date.now() - startedAt,
      resultItemCount: Array.isArray(result) ? result.length : undefined,
    },
  };
}

function _adapterNeedsBrowser(adapterName: string): boolean {
  const registry = getRegistry();
  const cmd = registry.get(adapterName);
  if (!cmd) return false;
  return shouldUseBrowserSession(cmd);
}

async function _ensureBrowserReady(
  stepName: string,
  step: WorkflowStep,
  callbacks?: WorkflowCallbacks,
): Promise<void> {
  let health: { state: string };
  try {
      // @ts-ignore — opencli internal, dynamic import with fallback
    const { getDaemonHealth } = await import('@jackwener/opencli/browser/daemon-transport' as string);
    health = await getDaemonHealth({ timeout: 3000 });
  } catch {
    health = { state: 'stopped' };
  }

  if (health.state === 'ready') return;

  // Browser not available — if step has auth + interactive callback,
  // let auth-retry handle it (it catches BrowserConnectError and shows auth UI)
  if (step.auth && callbacks?.onInteract) return;

  const messages: Record<string, string> = {
    stopped: 'Browser daemon not running (run: opencli daemon start)',
    'no-extension': 'Browser Bridge extension not connected (install and enable in Chrome)',
    'profile-required': 'Multiple browser profiles connected — select one (run: opencli auth profile)',
    'profile-disconnected': 'Browser profile disconnected — reopen Chrome with extension',
  };
  const detail = messages[health.state] || `Browser bridge state: ${health.state}`;
        // @ts-ignore — opencli internal, dynamic import with fallback
  const { BrowserConnectError } = await import('@jackwener/opencli/errors' as string);
  throw new BrowserConnectError(
    `${step.adapter} requires a browser but the Browser Bridge is not ready`,
    detail,
  );
}

async function _executeNestedWorkflow(
  workflowPath: string,
  inputArgs: Record<string, unknown>,
  debug: boolean,
  parentStepName?: string,
  callbacks?: WorkflowCallbacks,
  nestingDepth = 0,
  visitedPaths?: Set<string>,
  abortSignal?: AbortSignal,
  authedSites?: Set<string>,
  authQueue?: AuthQueue,
): Promise<{ context: Record<string, unknown>; runId: string }> {
  const resolvedPath = path.resolve(workflowPath);
  // Clone the visited set so parallel foreach branches don't conflict.
  // Each branch tracks its own ancestor chain independently.
  const visited = new Set(visitedPaths);

  if (visited.has(resolvedPath)) {
    throw new Error(`Circular workflow reference detected: "${resolvedPath}" is already in the call chain`);
  }
  visited.add(resolvedPath);

  const childDef = parseWorkflow(workflowPath);

  if (debug) {
    log.info?.(`    nested workflow: "${childDef.name}" (${Object.keys(childDef.steps).length} steps)`);
  }

  const scoped = parentStepName ? scopeChildCallbacks(parentStepName, callbacks) : callbacks;
  const result = await executeWorkflow(childDef, inputArgs, {
    debug,
    callbacks: scoped,
    quiet: !!scoped,
    _nestingDepth: nestingDepth + 1,
    _visitedPaths: visited,
    _abortSignal: abortSignal,
    _authedSites: authedSites,
    _authQueue: authQueue,
  });

  if (result.status === 'failed' || result.status === 'partial') {
    throw new Error(`Nested workflow "${childDef.name}" ${result.status}: ${result.error ?? 'one or more steps did not complete'}`);
  }

  if (childDef.outputs && childDef.outputs.length > 0) {
    const filtered: Record<string, unknown> = {};
    for (const key of childDef.outputs) {
      if (key in result.context) filtered[key] = result.context[key];
    }
    return { context: filtered, runId: result.id };
  }

  return { context: result.context, runId: result.id };
}

function scopeChildCallbacks(parentStepName: string, callbacks?: WorkflowCallbacks): WorkflowCallbacks | undefined {
  if (!callbacks) return undefined;
  const prefixed = (name: string) => `${parentStepName}/${name}`;
  return {
    onStepStart(e) { callbacks.onStepStart?.({ ...e, stepName: prefixed(e.stepName) }); },
    onStepEnd(e) { callbacks.onStepEnd?.({ ...e, stepName: prefixed(e.stepName) }); },
    onStepSkipped(e) { callbacks.onStepSkipped?.({ ...e, stepName: prefixed(e.stepName) }); },
    onStepRetry(e) { callbacks.onStepRetry?.({ ...e, stepName: prefixed(e.stepName) }); },
    onForeachProgress(e) { callbacks.onForeachProgress?.({ ...e, stepName: prefixed(e.stepName) }); },
    onInteract(stepName, spec) { return callbacks.onInteract?.(prefixed(stepName), spec) ?? Promise.resolve(undefined); },
    onInteractStart(e) { callbacks.onInteractStart?.({ ...e, stepName: prefixed(e.stepName) }); },
    onInteractEnd(e) { callbacks.onInteractEnd?.({ ...e, stepName: prefixed(e.stepName) }); },
  };
}

const _FOREACH_ITEM_FAILED = Symbol('foreach-item-failed');

/**
 * Combine multiple WorkflowCallbacks into one so several consumers (TUI renderer,
 * trace recorder) can observe the same engine run. For onInteract, the first
 * callback that defines it wins — only one UI should own the terminal at a time.
 */
export function mergeCallbacks(...cbs: (WorkflowCallbacks | undefined | null)[]): WorkflowCallbacks {
  const valid = cbs.filter((cb): cb is WorkflowCallbacks => Boolean(cb));
  if (valid.length === 0) return {};
  if (valid.length === 1) return valid[0];

  return {
    onWorkflowStart(event) { for (const cb of valid) cb.onWorkflowStart?.(event); },
    onWorkflowEnd(event) { for (const cb of valid) cb.onWorkflowEnd?.(event); },
    onStepStart(event) { for (const cb of valid) cb.onStepStart?.(event); },
    onStepEnd(event) { for (const cb of valid) cb.onStepEnd?.(event); },
    onStepSkipped(event) { for (const cb of valid) cb.onStepSkipped?.(event); },
    onStepRetry(event) { for (const cb of valid) cb.onStepRetry?.(event); },
    onForeachProgress(event) { for (const cb of valid) cb.onForeachProgress?.(event); },
    onInteract(stepName, spec) {
      const provider = valid.find(cb => cb.onInteract);
      return provider?.onInteract ? provider.onInteract(stepName, spec) : Promise.resolve(undefined);
    },
    onInteractStart(event) { for (const cb of valid) cb.onInteractStart?.(event); },
    onInteractEnd(event) { for (const cb of valid) cb.onInteractEnd?.(event); },
  };
}

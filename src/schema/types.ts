/**
 * Workflow type definitions (DAG model).
 */

export type StepErrorPolicy = 'stop' | 'skip' | 'retry';

export interface StepOutput {
  as?: string;
  map?: Record<string, string>;
}

export interface WorkflowInput {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
  description?: string;
}

// ── Interact types ──────────────────────────────────────────────────────────

export type InteractSpec =
  | { type: 'confirm'; message?: string; default?: boolean }
  | { type: 'select'; from: string; display?: string; message: string; default?: number }
  | { type: 'multi-select'; from: string; display?: string; message: string; default?: number[] }
  | { type: 'input'; message: string; default?: string };

export type ResolvedInteractSpec =
  | { type: 'confirm'; message: string; defaultValue?: boolean }
  | { type: 'select'; message: string; options: { label: string; value: unknown }[]; defaultValue?: unknown }
  | { type: 'multi-select'; message: string; options: { label: string; value: unknown }[]; defaultValues?: unknown[] }
  | { type: 'input'; message: string; default?: string }
  | { type: 'auth'; message: string; site: string; timeout: number };

// ── Step & Workflow definitions ─────────────────────────────────────────────

export interface WorkflowStep {
  adapter?: string;
  type?: 'adapter' | 'workflow';
  description?: string;
  args?: Record<string, unknown>;
  depends_on?: string[];
  foreach?: string;
  concurrency?: number;
  /** Delay in ms each foreach worker waits after finishing an item before starting its next one (rate-limiting a slow/flaky upstream). No effect outside `foreach`. */
  delay?: number;
  output?: string | StepOutput;
  condition?: string;
  on_error?: StepErrorPolicy;
  retries?: number;
  timeout?: number;
  /** Whether to flatten foreach results into a single array (default true). */
  flatten?: boolean;
  confirm?: boolean | string;
  auth?: boolean | {
    timeout?: number;           // 等待登录超时秒数，默认 120
    on_timeout?: 'skip' | 'abort';  // 超时行为，默认 'skip'
    max_retries?: number;       // 重试次数，默认 1
  };
  interact?: InteractSpec;

  // Nested workflow step fields
  workflow?: string;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInput>;
  outputs?: string[];
  steps: Record<string, WorkflowStep>;
  checkpoint?: boolean;
  on_error?: StepErrorPolicy;
  timeout?: number;
  max_parallel?: number;
}

// ── Event callback types ────────────────────────────────────────────────────

export interface StepEvent {
  stepName: string;
  step: WorkflowStep;
  description?: string;
}

export interface StepStartEvent extends StepEvent {
  startedAt: number;
}

export type SkipReason = 'condition_false' | 'missing_var' | 'on_error_skip' | 'dependency_failed' | 'auth_skipped' | 'interact_pending';
export type TraceErrorType = 'AuthRequiredError' | 'TimeoutError' | 'StepSkippedError' | 'AuthAbortedError' | 'GenericError';

// ── Trace event types ─────────────────────────────────────────────────────

export type TraceEventType =
  | 'step_start'
  | 'adapter_invoke'
  | 'adapter_result'
  | 'adapter_error'
  | 'condition_eval'
  | 'interact_open'
  | 'interact_resolve'
  | 'interact_reject'
  | 'interact_timeout'
  | 'step_timeout'
  | 'status_change'
  | 'retry_start'
  | 'retry_result'
  | 'foreach_item_start'
  | 'foreach_item_end'
  | 'auth_trigger'
  | 'auth_result'
  | 'step_end';

export interface TraceEvent {
  ts: number;
  type: TraceEventType;
  spanId?: string;
  detail?: Record<string, unknown>;
}

export type TerminationReason = 'completed' | 'failed' | 'aborted' | 'deadline' | 'sigint' | 'user_exit' | 'paused';

export interface DataFlowRecord {
  varName: string;
  producer: string;
  consumers: string[];
  valuePreview?: string;
  itemCount?: number;
}

export interface StepEndEvent extends StepEvent {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  /** Per-item error messages from a `foreach` step whose items failed under `on_error: skip` — the step itself still ends "completed", so this is the only place those failures surface. */
  foreachErrors?: string[];
  /** Resolved args actually passed to the adapter/nested workflow (after $variable substitution) — only set for non-foreach steps. */
  resolvedArgs?: Record<string, unknown>;
  /** The value this step wrote into the workflow context, and the variable name it was stored under. */
  output?: { varName: string; value: unknown };
  /** Why the step was skipped (only set when status === 'skipped'). */
  skipReason?: SkipReason;
  /** Variable names referenced by this step that were not available in context. */
  missingVars?: string[];
  /** Classified error type for diagnostics. */
  errorType?: TraceErrorType;
  /** Error cause chain for deep diagnostics. */
  errorCause?: Array<{ message: string; type?: string }>;
  /** Condition expression and its resolved value (set when step has a condition). */
  condition?: { expression: string; resolved: unknown };
  /** Foreach source expression and resolved item count. */
  foreachSource?: { expression: string; itemCount: number };
  /** RunId of a nested workflow (for trace correlation). */
  nestedRunId?: string;
  /** Adapter execution metadata (timing, strategy). */
  adapterExec?: AdapterExecMeta;
  /** Path to observation trace directory (browser commands only). */
  observationTracePath?: string;
}

export interface AdapterExecMeta {
  adapter: string;
  strategy?: string;
  startedAt: number;
  durationMs: number;
  resultItemCount?: number;
}

export interface StepRetryEvent extends StepEvent {
  attempt: number;
  maxRetries: number;
  error: string;
}

export interface ForeachProgressEvent extends StepEvent {
  completed: number;
  total: number;
  failed: number;
}

export interface StepSkippedEvent {
  stepName: string;
  reason: SkipReason;
  missingVars?: string[];
  ts: number;
}

export interface InteractStartEvent {
  stepName: string;
  spec: ResolvedInteractSpec;
  ts: number;
}

export interface InteractEndEvent {
  stepName: string;
  spec: ResolvedInteractSpec;
  result: unknown;
  durationMs: number;
  ts: number;
  autoResolved?: boolean;
}

export interface WorkflowCallbacks {
  onWorkflowStart?: (event: { runId: string; workflow: string; totalSteps: number; startedAt: number; definitionHash?: string; inputs?: Record<string, unknown> }) => void;
  onWorkflowEnd?: (event: { runId: string; status: string; finishedAt: number }) => void;
  onStepStart?: (event: StepStartEvent) => void;
  onStepEnd?: (event: StepEndEvent) => void;
  onStepSkipped?: (event: StepSkippedEvent) => void;
  onStepRetry?: (event: StepRetryEvent) => void;
  onForeachProgress?: (event: ForeachProgressEvent) => void;
  onInteract?: (stepName: string, spec: ResolvedInteractSpec) => Promise<unknown>;
  onInteractStart?: (event: InteractStartEvent) => void;
  onInteractEnd?: (event: InteractEndEvent) => void;
  onTraceEvent?: (stepName: string, event: TraceEvent) => void;
}

// ── Run result types ────────────────────────────────────────────────────────

export interface StepRecord {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  retries?: number;
  foreachErrors?: string[];
}

export interface WorkflowRunResult {
  id: string;
  workflow: string;
  status: 'completed' | 'failed' | 'partial' | 'paused';
  completedSteps: string[];
  failedSteps: string[];
  skippedSteps: string[];
  context: Record<string, unknown>;
  startedAt: number;
  finishedAt: number;
  error?: string;
  stepRecords: StepRecord[];
  terminationReason?: TerminationReason;
  dataFlow?: DataFlowRecord[];
  pendingInteracts?: PendingInteract[];
}

export interface PendingInteract {
  stepName: string;
  spec: ResolvedInteractSpec;
}

export interface CheckpointData {
  workflowName: string;
  runId: string;
  completedSteps: string[];
  context: Record<string, unknown>;
  startedAt: number;
  updatedAt: number;
  definitionHash?: string;
  pendingInteracts?: PendingInteract[];
}

export interface ExecutionWave {
  parallel: string[];
}

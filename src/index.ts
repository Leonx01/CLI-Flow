/**
 * Workflow module re-exports.
 */

export type {
  WorkflowStep,
  WorkflowDefinition,
  WorkflowRunResult,
  CheckpointData,
  ExecutionWave,
  StepOutput,
  WorkflowInput,
  InteractSpec,
  ResolvedInteractSpec,
  WorkflowCallbacks,
  StepEvent,
  StepStartEvent,
  StepEndEvent,
  StepRetryEvent,
  ForeachProgressEvent,
  StepRecord,
  AdapterExecMeta,
  InteractStartEvent,
  InteractEndEvent,
} from './schema/types.js';
export { parseWorkflow, WorkflowParseError } from './schema/parser.js';
export { DAGScheduler, CycleError } from './engine/scheduler.js';
export { WorkflowContext } from './engine/context.js';
export { executeWorkflow, mergeCallbacks, type WorkflowOptions } from './engine/engine.js';
export {
  generateRunId,
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  hashDefinition,
} from './engine/checkpoint.js';
export { validateWorkflow, type ValidationWarning } from './schema/validator.js';
export {
  isAuthRequiredError,
  classifyError,
  isConnectionError,
  extractErrorMessage,
  StepSkippedError,
  AuthAbortedError,
  type ErrorCategory,
} from './engine/error-classify.js';
export { applyOutputMap, mapFields } from './engine/output-map.js';
export { executeWithAuthRetry, createAuthQueue, type AuthQueue } from './engine/auth-retry.js';
export { probeAdapter, probeAdapters, type ProbeResult } from './preflight/probe.js';
export { preflightWorkflow, type PreflightResult, type PreflightCheck } from './preflight/preflight.js';
export {
  createTraceCallbacks,
  loadTrace,
  listTraces,
  traceFilePath,
  generateTraceSummary,
  type WorkflowTrace,
  type StepTraceRecord,
  type RetryTraceRecord,
} from './trace/trace.js';
export {
  createInteractHandler,
  AUTO_APPROVE_POLICY,
  AUTO_REJECT_POLICY,
  type InteractProvider,
  type InteractPolicy,
} from './engine/interact.js';
export {
  addNote,
  loadNotes,
  hasNotes,
  addAdapterNote,
  loadAdapterMemory,
  hasAdapterMemory,
  listAdapters,
  loadInsights,
  updateInsights,
  saveSnapshot,
  listSnapshots,
  findSnapshotByHash,
  diffSnapshots,
  loadMemory,
  deleteMemory,
  listMemories,
  getMemoryHint,
  type NoteEntry,
  type RecentFailure,
  type RunInsights,
  type SnapshotEntry,
  type MemoryReport,
} from './engine/memory.js';

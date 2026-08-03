/**
 * Trace recorder: captures per-step timing, status, retries, and foreach
 * progress for a workflow run and persists it to disk for post-hoc analysis.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WorkflowCallbacks, SkipReason, TraceErrorType, AdapterExecMeta, InteractStartEvent, TraceEvent, TerminationReason, DataFlowRecord } from '../schema/types.js';

const TRACE_DIR = path.join(os.homedir(), '.cliflow', 'traces');
const TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_OUTPUT_JSON_CHARS = 50_000; // ~50KB — covers virtually all normal step outputs, only caps scrape/bulk-fetch-style outliers

/** Caps a step's output value before it's persisted to disk, so one oversized foreach/scrape result can't turn the trace file into an unbounded second copy of the data. */
export function capOutputValue(value: unknown): { value: unknown; truncated: boolean } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value, truncated: false };
  }
  if (json === undefined || json.length <= MAX_OUTPUT_JSON_CHARS) return { value, truncated: false };

  if (Array.isArray(value)) {
    const avgItemLen = json.length / value.length;
    let n = Math.max(1, Math.min(value.length, Math.floor(MAX_OUTPUT_JSON_CHARS / avgItemLen)));
    let sliced = value.slice(0, n);
    let slicedJson = JSON.stringify(sliced) ?? '';

    while (n > 1 && slicedJson.length > MAX_OUTPUT_JSON_CHARS) {
      n = Math.floor(n / 2);
      sliced = value.slice(0, n);
      slicedJson = JSON.stringify(sliced) ?? '';
    }

    if (slicedJson.length > MAX_OUTPUT_JSON_CHARS) {
      return {
        value: `${slicedJson.slice(0, MAX_OUTPUT_JSON_CHARS)}… (truncated, ${slicedJson.length} chars total, 1 of ${value.length} items)`,
        truncated: true,
      };
    }
    return { value: sliced, truncated: true };
  }

  return { value: `${json.slice(0, MAX_OUTPUT_JSON_CHARS)}… (truncated, ${json.length} chars total)`, truncated: true };
}

export interface RetryTraceRecord {
  attempt: number;
  maxRetries: number;
  error: string;
  ts: number;
}

export interface StepTraceRecord {
  name: string;
  description?: string;
  adapter?: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  retries?: RetryTraceRecord[];
  foreach?: { total: number; completed: number; failed: number };
  foreachErrors?: string[];
  dependsOn?: string[];
  args?: Record<string, unknown>;
  output?: { varName: string; value: unknown; truncated?: boolean };
  skipReason?: SkipReason;
  missingVars?: string[];
  errorType?: TraceErrorType;
  errorCause?: Array<{ message: string; type?: string }>;
  condition?: { expression: string; resolved: unknown };
  foreachSource?: { expression: string; itemCount: number };
  nestedRunId?: string;
  adapterExec?: AdapterExecMeta;
  observationTracePath?: string;
  events?: TraceEvent[];
  interacts?: Array<{
    type: string;
    message: string;
    startedAt: number;
    durationMs: number;
    result?: unknown;
    autoResolved?: boolean;
  }>;
}

export interface WorkflowTrace {
  schemaVersion: 1 | 2 | 3;
  runId: string;
  workflow: string;
  startedAt: number;
  finishedAt?: number;
  status?: string;
  definitionHash?: string;
  inputs?: Record<string, unknown>;
  terminationReason?: TerminationReason;
  finalContext?: Record<string, unknown>;
  dataFlow?: DataFlowRecord[];
  steps: StepTraceRecord[];
}

function ensureDir(): void {
  if (!fs.existsSync(TRACE_DIR)) {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
  }
}

function safePath(runId: string): string {
  const resolved = path.resolve(TRACE_DIR, `${runId}.trace.json`);
  if (!resolved.startsWith(path.resolve(TRACE_DIR) + path.sep)) {
    throw new Error('Invalid runId: path traversal detected');
  }
  return resolved;
}

function pruneOldTraces(): void {
  ensureDir();
  const now = Date.now();
  for (const file of fs.readdirSync(TRACE_DIR)) {
    if (!file.endsWith('.trace.json')) continue;
    const filePath = path.join(TRACE_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > TRACE_RETENTION_MS) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore races/corrupted entries
    }
  }
}

export function traceFilePath(runId: string): string {
  return safePath(runId);
}

export function createTraceCallbacks(): {
  callbacks: WorkflowCallbacks;
  finalize: (status: string, finishedAt: number, extra?: {
    terminationReason?: TerminationReason;
    finalContext?: Record<string, unknown>;
    dataFlow?: DataFlowRecord[];
  }) => string | null;
} {
  const trace: WorkflowTrace = {
    schemaVersion: 3,
    runId: '',
    workflow: '',
    startedAt: 0,
    steps: [],
  };

  const stepMap = new Map<string, StepTraceRecord>();

  const callbacks: WorkflowCallbacks = {
    onWorkflowStart(event) {
      trace.runId = event.runId;
      trace.workflow = event.workflow;
      trace.startedAt = event.startedAt;
      if (event.definitionHash) trace.definitionHash = event.definitionHash;
      if (event.inputs) trace.inputs = event.inputs;
    },
    onStepStart(event) {
      const record: StepTraceRecord = {
        name: event.stepName,
        description: event.description,
        adapter: event.step.adapter,
        status: 'running',
        startedAt: event.startedAt,
        dependsOn: event.step.depends_on,
      };
      stepMap.set(event.stepName, record);
      trace.steps.push(record);
    },
    onStepEnd(event) {
      const record = stepMap.get(event.stepName);
      if (!record) return;
      record.status = event.status;
      record.finishedAt = event.finishedAt;
      record.durationMs = event.durationMs;
      record.error = event.error;
      record.foreachErrors = event.foreachErrors;
      record.args = event.resolvedArgs;
      if (event.output) {
        const { value, truncated } = capOutputValue(event.output.value);
        record.output = { varName: event.output.varName, value, truncated: truncated || undefined };
      }
      if (event.skipReason) record.skipReason = event.skipReason;
      if (event.missingVars) record.missingVars = event.missingVars;
      if (event.errorType) record.errorType = event.errorType;
      if (event.errorCause) record.errorCause = event.errorCause;
      if (event.condition) record.condition = event.condition;
      if (event.foreachSource) record.foreachSource = event.foreachSource;
      if (event.nestedRunId) record.nestedRunId = event.nestedRunId;
      if (event.adapterExec) record.adapterExec = event.adapterExec;
      if (event.observationTracePath) record.observationTracePath = event.observationTracePath;
    },
    onStepSkipped(event) {
      const record = stepMap.get(event.stepName);
      if (!record) return;
      record.skipReason = event.reason;
      if (event.missingVars) record.missingVars = event.missingVars;
    },
    onStepRetry(event) {
      const record = stepMap.get(event.stepName);
      if (!record) return;
      record.retries ??= [];
      record.retries.push({
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        error: event.error,
        ts: Date.now(),
      });
    },
    onForeachProgress(event) {
      const record = stepMap.get(event.stepName);
      if (!record) return;
      record.foreach = { total: event.total, completed: event.completed, failed: event.failed };
    },
    onInteractStart(event: InteractStartEvent) {
      const record = stepMap.get(event.stepName);
      if (!record) return;
      record.interacts ??= [];
      record.interacts.push({
        type: event.spec.type,
        message: event.spec.message,
        startedAt: event.ts,
        durationMs: 0,
      });
    },
    onInteractEnd(event) {
      const record = stepMap.get(event.stepName);
      if (!record || !record.interacts?.length) return;
      const last = record.interacts[record.interacts.length - 1];
      last.durationMs = event.durationMs;
      last.result = event.result;
      if (event.autoResolved) last.autoResolved = true;
    },
    onTraceEvent(stepName: string, event: TraceEvent) {
      const record = stepMap.get(stepName);
      if (!record) return;
      record.events ??= [];
      record.events.push(event);
    },
  };

  function finalize(status: string, finishedAt: number, extra?: {
    terminationReason?: TerminationReason;
    finalContext?: Record<string, unknown>;
    dataFlow?: DataFlowRecord[];
  }): string | null {
    if (!trace.runId) return null;
    trace.status = status;
    trace.finishedAt = finishedAt;
    if (extra?.terminationReason) trace.terminationReason = extra.terminationReason;
    if (extra?.dataFlow && extra.dataFlow.length > 0) trace.dataFlow = extra.dataFlow;
    if (extra?.finalContext) {
      const { value } = capOutputValue(extra.finalContext);
      trace.finalContext = value as Record<string, unknown>;
    }
    ensureDir();
    const filePath = safePath(trace.runId);
    fs.writeFileSync(filePath, JSON.stringify(trace, null, 2));
    pruneOldTraces();
    return filePath;
  }

  return { callbacks, finalize };
}

export function loadTrace(runId: string): WorkflowTrace | null {
  const filePath = safePath(runId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkflowTrace;
  } catch {
    return null;
  }
}

export function listTraces(): WorkflowTrace[] {
  ensureDir();
  const traces: WorkflowTrace[] = [];
  for (const file of fs.readdirSync(TRACE_DIR)) {
    if (!file.endsWith('.trace.json')) continue;
    try {
      traces.push(JSON.parse(fs.readFileSync(path.join(TRACE_DIR, file), 'utf-8')) as WorkflowTrace);
    } catch {
      // skip corrupted files
    }
  }
  return traces.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function generateTraceSummary(trace: WorkflowTrace): string {
  const lines: string[] = [];
  const duration = trace.finishedAt && trace.startedAt
    ? ((trace.finishedAt - trace.startedAt) / 1000).toFixed(1) + 's'
    : '—';

  lines.push(`Workflow: ${trace.workflow} (run ${trace.runId})`);
  const headerParts = [`Status: ${trace.status ?? 'unknown'}`, `Duration: ${duration}`];
  if (trace.definitionHash) headerParts.push(`Definition: ${trace.definitionHash}`);
  if (trace.terminationReason && trace.terminationReason !== 'completed') {
    headerParts.push(`Termination: ${trace.terminationReason}`);
  }
  lines.push(headerParts.join(' | '));
  if (trace.inputs && Object.keys(trace.inputs).length > 0) {
    lines.push(`Inputs: ${JSON.stringify(trace.inputs)}`);
  }

  const counts = { completed: 0, failed: 0, skipped: 0, running: 0 };
  for (const s of trace.steps) counts[s.status]++;
  lines.push('');
  lines.push(`Steps (${trace.steps.length} total: ${counts.completed} completed, ${counts.failed} failed, ${counts.skipped} skipped):`);
  lines.push('');

  const icons: Record<string, string> = { completed: '✓', failed: '✗', skipped: '⊘', running: '…' };
  const failedStepNames = new Set(trace.steps.filter(s => s.status === 'failed').map(s => s.name));

  // Real per-variable item counts live in dataFlow; a step's output.value may have
  // been sliced by capOutputValue() to bound the trace file, so its .length under-
  // reports (e.g. shows 216 of 625). Prefer the authoritative dataFlow count.
  const realItemCount = new Map<string, number>();
  for (const d of trace.dataFlow ?? []) {
    if (typeof d.itemCount === 'number') realItemCount.set(d.varName, d.itemCount);
  }

  for (const s of trace.steps) {
    const icon = icons[s.status] ?? '?';
    const dur = s.durationMs !== undefined ? (s.durationMs / 1000).toFixed(1) + 's' : '—';
    const namePad = s.name.padEnd(20);
    let adapterInfo = '';
    if (s.adapterExec) {
      adapterInfo = `${s.adapterExec.adapter}`;
      if (s.adapterExec.strategy) adapterInfo += ` [${s.adapterExec.strategy}]`;
    } else if (s.adapter) {
      adapterInfo = s.adapter;
    }

    let outputInfo = '';
    if (s.output) {
      const authoritative = realItemCount.get(s.output.varName);
      let count: string;
      if (authoritative !== undefined) {
        // Note when the persisted preview holds fewer items than were actually produced.
        const previewLen = Array.isArray(s.output.value) ? (s.output.value as unknown[]).length : undefined;
        count = previewLen !== undefined && previewLen < authoritative
          ? `${authoritative} items, preview ${previewLen}`
          : `${authoritative} items`;
      } else {
        count = Array.isArray(s.output.value) ? `${(s.output.value as unknown[]).length} items` : typeof s.output.value;
      }
      outputInfo = ` → ${s.output.varName} (${count})`;
      if (s.output.truncated) outputInfo += ' [truncated]';
    }

    let foreachInfo = '';
    if (s.foreach) {
      foreachInfo = ` foreach=${s.foreach.completed}/${s.foreach.total}/${s.foreach.failed}`;
    }

    lines.push(`  ${icon} ${namePad} ${dur.padStart(6)}  ${adapterInfo}${foreachInfo}${outputInfo}`);

    if (s.error) {
      const typePrefix = s.errorType ? `${s.errorType} — ` : '';
      lines.push(`    Error: ${typePrefix}${s.error}`);
    }
    if (s.errorCause && s.errorCause.length > 1) {
      lines.push(`    Cause: ${s.errorCause.map(c => c.type ?? c.message).join(' → ')}`);
    }
    if (s.skipReason) {
      lines.push(`    Skip reason: ${s.skipReason}`);
    }
    if (s.missingVars && s.missingVars.length > 0) {
      lines.push(`    Missing: ${s.missingVars.map(v => '$' + v).join(', ')}`);
    }
    if (s.condition) {
      const resolvedStr = s.condition.resolved === undefined ? 'undefined' : JSON.stringify(s.condition.resolved);
      lines.push(`    Condition: "${s.condition.expression}" → ${resolvedStr}`);
    }
    if (s.foreachSource) {
      lines.push(`    Foreach source: "${s.foreachSource.expression}" (${s.foreachSource.itemCount} items)`);
    }
    if (s.nestedRunId) {
      lines.push(`    Nested workflow run: ${s.nestedRunId}`);
    }
    if (s.interacts && s.interacts.length > 0) {
      for (const ia of s.interacts) {
        const dur = (ia.durationMs / 1000).toFixed(1) + 's';
        const auto = ia.autoResolved ? ' [auto]' : '';
        const resultStr = ia.result !== undefined ? ` → ${JSON.stringify(ia.result)}` : '';
        lines.push(`    Interact: ${ia.type} "${ia.message}" ${dur}${auto}${resultStr}`);
      }
    }
    if (s.observationTracePath) {
      lines.push(`    Observation: ${s.observationTracePath}`);
    }
    if (s.foreachErrors && s.foreachErrors.length > 0) {
      for (const e of s.foreachErrors.slice(0, 5)) {
        lines.push(`    foreach error: ${e}`);
      }
      if (s.foreachErrors.length > 5) {
        lines.push(`    ... and ${s.foreachErrors.length - 5} more`);
      }
    }

    if (s.events && s.events.length > 0 && (s.status === 'failed' || s.status === 'skipped' && s.error)) {
      lines.push('    Call chain:');
      const stepStart = s.startedAt;
      const grouped = groupEventsBySpan(s.events);
      for (const group of grouped) {
        const parts = group.events.map(e => {
          const rel = ((e.ts - stepStart) / 1000).toFixed(1);
          let label = e.type;
          if (e.detail) {
            const hint = e.detail.error ?? e.detail.result ?? e.detail.adapter ?? e.detail.reason;
            if (hint !== undefined) label += `(${String(hint).slice(0, 40)})`;
          }
          return `+${rel}s ${label}`;
        });
        const prefix = group.spanId ? `[${group.spanId}]` : '[—]';
        lines.push(`      ${prefix.padEnd(16)} ${parts.join(' → ')}`);
      }
    }
  }

  if (failedStepNames.size > 0) {
    lines.push('');
    lines.push('Failed/Skipped Dependency Chain:');
    for (const failedName of failedStepNames) {
      const blocked = trace.steps
        .filter(s => s.status === 'skipped' && s.dependsOn?.some(d => failedStepNames.has(d)))
        .map(s => s.name);
      const failedStep = trace.steps.find(s => s.name === failedName);
      const typeInfo = failedStep?.errorType ? ` (${failedStep.errorType})` : '';
      if (blocked.length > 0) {
        lines.push(`  ${failedName}${typeInfo} → blocked: ${blocked.join(', ')}`);
      } else {
        lines.push(`  ${failedName}${typeInfo}`);
      }
    }
  }

  if (trace.dataFlow && trace.dataFlow.length > 0) {
    lines.push('');
    lines.push('Data Flow:');
    for (const df of trace.dataFlow) {
      const preview = df.valuePreview ?? '?';
      const consumers = df.consumers.length > 0 ? df.consumers.join(', ') : '(unused)';
      lines.push(`  ${df.varName.padEnd(20)} ← ${df.producer} (${preview}) → ${consumers}`);
    }
  }

  if (trace.finalContext && Object.keys(trace.finalContext).length > 0) {
    lines.push('');
    const varNames = Object.keys(trace.finalContext);
    lines.push(`Context variables (${varNames.length}): ${varNames.join(', ')}`);
  }

  return lines.join('\n');
}

function groupEventsBySpan(events: TraceEvent[]): Array<{ spanId: string | undefined; events: TraceEvent[] }> {
  const groups: Array<{ spanId: string | undefined; events: TraceEvent[] }> = [];
  const spanMap = new Map<string, TraceEvent[]>();
  const unspanned: TraceEvent[] = [];

  for (const e of events) {
    if (e.spanId) {
      let arr = spanMap.get(e.spanId);
      if (!arr) {
        arr = [];
        spanMap.set(e.spanId, arr);
      }
      arr.push(e);
    } else {
      unspanned.push(e);
    }
  }

  for (const [spanId, spanEvents] of spanMap) {
    groups.push({ spanId, events: spanEvents });
  }
  if (unspanned.length > 0) {
    groups.push({ spanId: undefined, events: unspanned });
  }

  groups.sort((a, b) => (a.events[0]?.ts ?? 0) - (b.events[0]?.ts ?? 0));
  return groups;
}

export function generateValuePreview(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length <= 4) return `Object{${keys.join(',')}}`;
    return `Object{${keys.slice(0, 3).join(',')},...+${keys.length - 3}}`;
  }
  if (typeof value === 'string') {
    return value.length > 60 ? `string(${value.length})` : JSON.stringify(value);
  }
  return String(value);
}

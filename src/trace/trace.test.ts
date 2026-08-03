/**
 * Tests for the structured trace recorder (Phase 2):
 * - createTraceCallbacks captures per-step timing/status/retries/foreach
 * - finalize() writes a trace file keyed by the real runId (from onWorkflowStart)
 * - loadTrace / listTraces round-trip correctly
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { executeWorkflow, mergeCallbacks } from '../engine/engine.js';
import { createTraceCallbacks, loadTrace, listTraces, traceFilePath, capOutputValue, generateValuePreview } from './trace.js';

cli({
  site: 'trace-test',
  name: 'echo',
  description: 'test echo adapter',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'value', type: 'string' }],
  func: async (kwargs) => ({ value: kwargs.value }),
});

let failOnce = false;
cli({
  site: 'trace-test',
  name: 'maybe-fail',
  description: 'fails once when failOnce is set',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  func: async () => {
    if (failOnce) { failOnce = false; throw new Error('boom'); }
    return { ok: true };
  },
});

cli({
  site: 'trace-test',
  name: 'slow',
  description: 'takes longer than a short timeout',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  func: async () => {
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { done: true };
  },
});

const writtenTraceFiles: string[] = [];

afterEach(() => {
  for (const f of writtenTraceFiles) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  writtenTraceFiles.length = 0;
});

describe('Workflow trace recorder', () => {
  it('captures per-step timing and status, and writes a trace file', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-basic-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'trace-test/echo', args: { value: 'hi' } },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    expect(filePath).toBeTruthy();
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.workflow).toBe('trace-basic-test');
    expect(loaded!.status).toBe('completed');
    expect(loaded!.steps).toHaveLength(1);
    expect(loaded!.steps[0].name).toBe('s1');
    expect(loaded!.steps[0].status).toBe('completed');
    expect(loaded!.steps[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records retries and foreach progress', async () => {
    failOnce = true;
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-retry-foreach-test',
      steps: {
        'flaky': {
          type: 'adapter' as const,
          adapter: 'trace-test/maybe-fail',
          on_error: 'retry' as const,
          retries: 1,
        },
        'batch': {
          type: 'adapter' as const,
          adapter: 'trace-test/echo',
          foreach: '$items',
          args: { value: '$item.v' },
          output: 'results',
          depends_on: ['flaky'],
        },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, { items: [{ v: 'a' }, { v: 'b' }] }, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const flakyRecord = loaded.steps.find(s => s.name === 'flaky')!;
    expect(flakyRecord.retries).toHaveLength(1);
    expect(flakyRecord.status).toBe('completed');

    const batchRecord = loaded.steps.find(s => s.name === 'batch')!;
    expect(batchRecord.foreach).toEqual({ total: 2, completed: 2, failed: 0 });
  });

  it('finalize returns null when the workflow never started (e.g. dry run)', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-dryrun-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'trace-test/echo', args: { value: 'hi' } },
      },
      checkpoint: false,
    };
    const result = await executeWorkflow(def, {}, { dryRun: true, callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    expect(filePath).toBeNull();
  });

  it('listTraces includes a freshly written trace, sorted newest first', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-list-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'trace-test/echo', args: { value: 'hi' } },
      },
      checkpoint: false,
    };
    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const all = listTraces();
    expect(all.some(t => t.runId === result.id)).toBe(true);
    expect(traceFilePath(result.id)).toBe(filePath);
  });
});

describe('capOutputValue', () => {
  it('leaves small arrays untouched with no truncated flag', () => {
    const small = Array.from({ length: 100 }, (_, i) => ({ i, name: `item-${i}` }));
    const out = capOutputValue(small);
    expect(out.truncated).toBe(false);
    expect(out.value).toEqual(small);
  });

  it('caps a huge single-element array via a bounded preview instead of returning the oversized element', () => {
    // One element whose JSON alone exceeds the cap — the old halving loop
    // returned [hugeElement] unchanged with a misleading truncated flag.
    const huge = ['x'.repeat(60_000)];
    const out = capOutputValue(huge);
    expect(out.truncated).toBe(true);
    const persisted = JSON.stringify(out.value);
    expect(persisted.length).toBeLessThan(52_000); // bounded by ~MAX + small suffix
  });

  it('caps a large array of normal-size elements by halving the item count', () => {
    // 5_000 small objects → total JSON well over the cap; halves until it fits.
    const big = Array.from({ length: 5_000 }, (_, i) => ({ i, name: `item-${i}` }));
    const out = capOutputValue(big);
    expect(out.truncated).toBe(true);
    expect(Array.isArray(out.value)).toBe(true);
    const persisted = JSON.stringify(out.value);
    expect(persisted.length).toBeLessThanOrEqual(50_000);
  });

  it('caps a single oversized non-array value with a bounded preview', () => {
    const out = capOutputValue('y'.repeat(60_000));
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.value).length).toBeLessThan(52_000);
  });
});

describe('Trace events timeline', () => {
  it('records adapter_invoke and adapter_result events with spanId', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-events-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'trace-test/echo', args: { value: 'hello' } },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt, {
      terminationReason: result.terminationReason,
      dataFlow: result.dataFlow,
    });
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    expect(loaded.schemaVersion).toBe(3);
    const step = loaded.steps.find(s => s.name === 's1')!;
    expect(step.events).toBeDefined();
    expect(step.events!.length).toBeGreaterThanOrEqual(2);

    const invoke = step.events!.find(e => e.type === 'adapter_invoke');
    const res = step.events!.find(e => e.type === 'adapter_result');
    expect(invoke).toBeDefined();
    expect(res).toBeDefined();
    expect(invoke!.spanId).toBe('adapter-0');
    expect(res!.spanId).toBe('adapter-0');
  });

  it('records retry_start and retry_result events', async () => {
    failOnce = true;
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-retry-events-test',
      steps: {
        'flaky': {
          type: 'adapter' as const,
          adapter: 'trace-test/maybe-fail',
          on_error: 'retry' as const,
          retries: 1,
        },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const step = loaded.steps.find(s => s.name === 'flaky')!;
    expect(step.events).toBeDefined();

    const retryStart = step.events!.find(e => e.type === 'retry_start');
    const retryResult = step.events!.find(e => e.type === 'retry_result');
    expect(retryStart).toBeDefined();
    expect(retryStart!.spanId).toBe('retry-1');
    expect(retryResult).toBeDefined();
    expect(retryResult!.detail?.success).toBe(true);
  });

  it('records step_timeout event on timeout', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-timeout-events-test',
      steps: {
        'slow-step': {
          type: 'adapter' as const,
          adapter: 'trace-test/slow',
          timeout: 1,
          on_error: 'skip' as const,
        },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const step = loaded.steps.find(s => s.name === 'slow-step')!;
    expect(step.status).toBe('skipped');
    expect(step.events).toBeDefined();

    const timeout = step.events!.find(e => e.type === 'step_timeout');
    expect(timeout).toBeDefined();
    expect(timeout!.detail?.timeoutSec).toBe(1);
  });
});

describe('Trace data flow', () => {
  it('records producer and consumer relationships', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-dataflow-test',
      steps: {
        'produce': {
          type: 'adapter' as const,
          adapter: 'trace-test/echo',
          args: { value: 'data' },
          output: 'my_var',
        },
        'consume': {
          type: 'adapter' as const,
          adapter: 'trace-test/echo',
          args: { value: '$my_var' },
          depends_on: ['produce'],
        },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt, {
      dataFlow: result.dataFlow,
    });
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    expect(loaded.dataFlow).toBeDefined();

    const flow = loaded.dataFlow!.find(f => f.varName === 'my_var');
    expect(flow).toBeDefined();
    expect(flow!.producer).toBe('produce');
    expect(flow!.consumers).toContain('consume');
  });
});

describe('Trace terminationReason and finalContext', () => {
  it('persists terminationReason and finalContext', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-termination-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'trace-test/echo', args: { value: 'x' }, output: 'out' },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt, {
      terminationReason: 'completed',
      finalContext: result.context,
    });
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    expect(loaded.terminationReason).toBe('completed');
    expect(loaded.finalContext).toBeDefined();
    expect(loaded.finalContext!.out).toBeDefined();
  });
});

describe('generateValuePreview', () => {
  it('handles arrays', () => {
    expect(generateValuePreview([1, 2, 3])).toBe('Array(3)');
  });

  it('handles objects with few keys', () => {
    expect(generateValuePreview({ a: 1, b: 2 })).toBe('Object{a,b}');
  });

  it('handles objects with many keys', () => {
    expect(generateValuePreview({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe('Object{a,b,c,...+2}');
  });

  it('handles primitives', () => {
    expect(generateValuePreview(42)).toBe('42');
    expect(generateValuePreview(null)).toBe('null');
    expect(generateValuePreview(undefined)).toBe('undefined');
  });

  it('handles short strings as JSON', () => {
    expect(generateValuePreview('hello')).toBe('"hello"');
  });

  it('handles long strings with length', () => {
    const long = 'x'.repeat(100);
    expect(generateValuePreview(long)).toBe('string(100)');
  });
});

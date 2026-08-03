import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { executeWorkflow, mergeCallbacks } from './engine.js';
import { createTraceCallbacks, loadTrace, generateTraceSummary } from '../trace/trace.js';
import { parseWorkflow, WorkflowParseError } from '../schema/parser.js';
import { validateWorkflow } from '../schema/validator.js';
import type { WorkflowDefinition } from '../schema/types.js';

cli({
  site: 'phase2-test',
  name: 'echo',
  description: 'echo adapter',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'value', type: 'string' }],
  func: async (kwargs) => ({ value: kwargs.value }),
});

cli({
  site: 'phase2-test',
  name: 'list',
  description: 'returns an array of items',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  func: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
});

cli({
  site: 'phase2-test',
  name: 'fail',
  description: 'always fails',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  func: async () => { throw new Error('intentional failure'); },
});

const writtenTraceFiles: string[] = [];
const tempFiles: string[] = [];

function writeTempYaml(content: string): string {
  const tmpFile = path.join(os.tmpdir(), `opencli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(tmpFile, content);
  tempFiles.push(tmpFile);
  return tmpFile;
}

afterEach(() => {
  for (const f of writtenTraceFiles) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  writtenTraceFiles.length = 0;
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  tempFiles.length = 0;
});

describe('parser auth validation', () => {
  it('rejects auth on step without adapter', () => {
    const yamlPath = writeTempYaml(`
name: test
steps:
  interact-step:
    interact:
      type: input
      message: "Enter something"
    auth: true
`);
    expect(() => parseWorkflow(yamlPath)).toThrow(WorkflowParseError);
  });

  it('accepts auth on step with adapter', () => {
    const yamlPath = writeTempYaml(`
name: test
steps:
  fetch:
    adapter: site/cmd
    auth: required
`);
    const def = parseWorkflow(yamlPath);
    expect(def.steps['fetch'].auth).toBe(true);
  });
});

describe('parser flatten option', () => {
  it('parses flatten: false', () => {
    const yamlPath = writeTempYaml(`
name: test
steps:
  fetch:
    adapter: site/cmd
    foreach: "$items"
    flatten: false
`);
    const def = parseWorkflow(yamlPath);
    expect(def.steps['fetch'].flatten).toBe(false);
  });

  it('rejects non-boolean flatten', () => {
    const yamlPath = writeTempYaml(`
name: test
steps:
  fetch:
    adapter: site/cmd
    flatten: "yes"
`);
    expect(() => parseWorkflow(yamlPath)).toThrow(WorkflowParseError);
  });
});

describe('validator collision detection', () => {
  it('warns on output variable name collision from dash/underscore steps', () => {
    const def: WorkflowDefinition = {
      name: 'test',
      steps: {
        'fetch-data': { adapter: 'site/cmd' },
        'fetch_data': { adapter: 'site/cmd', depends_on: ['fetch-data'] },
      },
    };
    const warnings = validateWorkflow(def);
    const collisionWarning = warnings.find(w => w.message.includes('collides'));
    expect(collisionWarning).toBeDefined();
    expect(collisionWarning!.reference).toBe('$fetch_data');
  });

  it('does not warn when no collision', () => {
    const def: WorkflowDefinition = {
      name: 'test',
      steps: {
        'step-a': { adapter: 'site/cmd' },
        'step-b': { adapter: 'site/cmd', depends_on: ['step-a'] },
      },
    };
    const warnings = validateWorkflow(def);
    const collisionWarnings = warnings.filter(w => w.message.includes('collides'));
    expect(collisionWarnings).toHaveLength(0);
  });
});

describe('foreach flatten control', () => {
  it('flattens by default (flatten !== false)', async () => {
    const def = {
      name: 'flatten-default-test',
      steps: {
        'batch': {
          type: 'adapter' as const,
          adapter: 'phase2-test/list',
          foreach: '$items',
        },
      },
    };

    const result = await executeWorkflow(def, { items: ['a', 'b'] });
    expect(result.status).toBe('completed');
    const batchOutput = result.context['batch'] as unknown[];
    expect(Array.isArray(batchOutput)).toBe(true);
    expect(batchOutput.every(item => typeof item === 'object' && 'id' in (item as Record<string, unknown>))).toBe(true);
  });

  it('preserves nested structure with flatten: false', async () => {
    const def = {
      name: 'flatten-false-test',
      steps: {
        'batch': {
          type: 'adapter' as const,
          adapter: 'phase2-test/list',
          foreach: '$items',
          flatten: false,
        },
      },
    };

    const result = await executeWorkflow(def, { items: ['a', 'b'] });
    expect(result.status).toBe('completed');
    const batchOutput = result.context['batch'] as unknown[];
    expect(Array.isArray(batchOutput)).toBe(true);
    expect(batchOutput).toHaveLength(2);
    expect(Array.isArray(batchOutput[0])).toBe(true);
  });
});

describe('trace diagnostic context', () => {
  it('captures definitionHash and inputs in trace', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-context-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'phase2-test/echo', args: { value: 'hi' } },
      },
    };

    const inputs = { custom: 'value' };
    const result = await executeWorkflow(def, inputs, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    expect(loaded.schemaVersion).toBe(3);
    expect(loaded.definitionHash).toBeTruthy();
    expect(loaded.inputs).toEqual(inputs);
  });

  it('captures condition expression when condition is false', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-condition-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'phase2-test/echo', args: { value: 'hi' } },
        's2': {
          type: 'adapter' as const,
          adapter: 'phase2-test/echo',
          args: { value: 'bye' },
          depends_on: ['s1'],
          condition: '$nonexistent_var',
        },
      },
      inputs: { nonexistent_var: { default: false } },
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const s2Record = loaded.steps.find(s => s.name === 's2')!;
    expect(s2Record.status).toBe('skipped');
    expect(s2Record.condition).toBeDefined();
    expect(s2Record.condition!.expression).toBe('$nonexistent_var');
  });

  it('captures foreachSource in trace', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-foreach-source-test',
      steps: {
        'batch': {
          type: 'adapter' as const,
          adapter: 'phase2-test/echo',
          foreach: '$items',
          args: { value: '$item' },
        },
      },
    };

    const result = await executeWorkflow(def, { items: ['a', 'b', 'c'] }, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const batchRecord = loaded.steps.find(s => s.name === 'batch')!;
    expect(batchRecord.foreachSource).toBeDefined();
    expect(batchRecord.foreachSource!.expression).toBe('$items');
    expect(batchRecord.foreachSource!.itemCount).toBe(3);
  });

  it('captures adapterExec metadata', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'trace-adapter-exec-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'phase2-test/echo', args: { value: 'test' } },
      },
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const s1Record = loaded.steps.find(s => s.name === 's1')!;
    expect(s1Record.adapterExec).toBeDefined();
    expect(s1Record.adapterExec!.adapter).toBe('phase2-test/echo');
    expect(typeof s1Record.adapterExec!.strategy).toBe('string');
    expect(s1Record.adapterExec!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('generateTraceSummary', () => {
  it('generates readable summary with all fields', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'summary-test',
      steps: {
        'fetch': { type: 'adapter' as const, adapter: 'phase2-test/echo', args: { value: 'hi' } },
        'process': {
          type: 'adapter' as const,
          adapter: 'phase2-test/echo',
          args: { value: '$fetch.value' },
          depends_on: ['fetch'],
        },
      },
    };

    const result = await executeWorkflow(def, { topic: 'AI' }, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const summary = generateTraceSummary(loaded);

    expect(summary).toContain('Workflow: summary-test');
    expect(summary).toContain('Status: completed');
    expect(summary).toContain('2 completed');
    expect(summary).toContain('fetch');
    expect(summary).toContain('process');
    expect(summary).toContain('Definition:');
  });

  it('includes failure chain analysis', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'summary-fail-test',
      steps: {
        'broken': {
          type: 'adapter' as const,
          adapter: 'phase2-test/fail',
          on_error: 'stop' as const,
        },
        'downstream': {
          type: 'adapter' as const,
          adapter: 'phase2-test/echo',
          args: { value: '$broken' },
          depends_on: ['broken'],
        },
      },
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const summary = generateTraceSummary(loaded);

    expect(summary).toContain('✗');
    expect(summary).toContain('broken');
    expect(summary).toContain('Failed/Skipped Dependency Chain');
  });

  it('includes condition info for skipped steps', async () => {
    const trace = createTraceCallbacks();
    const def = {
      name: 'summary-condition-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'phase2-test/echo', args: { value: 'hi' } },
        'conditional': {
          type: 'adapter' as const,
          adapter: 'phase2-test/echo',
          args: { value: 'x' },
          depends_on: ['s1'],
          condition: '$falsy_val',
        },
      },
      inputs: { falsy_val: { default: false } },
    };

    const result = await executeWorkflow(def, {}, { callbacks: mergeCallbacks(trace.callbacks) });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const summary = generateTraceSummary(loaded);

    expect(summary).toContain('Condition:');
    expect(summary).toContain('$falsy_val');
  });
});

describe('AbortController signal cascade', () => {
  it('pre-aborted signal prevents any steps from running', async () => {
    const ac = new AbortController();
    ac.abort();

    const def = {
      name: 'abort-test',
      steps: {
        's1': { type: 'adapter' as const, adapter: 'phase2-test/echo', args: { value: 'hi' } },
      },
    };

    const result = await executeWorkflow(def, {}, { _abortSignal: ac.signal });
    expect(result.status).toBe('partial');
    expect(result.completedSteps).toHaveLength(0);
  });
});

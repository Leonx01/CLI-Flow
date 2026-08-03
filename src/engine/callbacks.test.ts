/**
 * Tests for the workflow engine's callback/event system (Phase 1):
 * - onStepStart / onStepEnd fire correctly for success, failure, skip
 * - onStepRetry fires during retry backoff
 * - onForeachProgress fires incrementally during foreach execution
 * - onInteract drives confirm / select / multi-select / input steps
 * - Fallback behavior when no onInteract callback is supplied
 * - stepRecords are populated on the run result
 * - mergeCallbacks fans events out to multiple consumers
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { executeWorkflow, mergeCallbacks } from './engine.js';
import { parseWorkflow, WorkflowParseError } from '../schema/parser.js';
import type { WorkflowCallbacks, ResolvedInteractSpec } from '../schema/types.js';

cli({
  site: 'cb-test',
  name: 'echo',
  description: 'test echo adapter',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'value', type: 'string' }],
  func: async (kwargs) => ({ value: kwargs.value }),
});

let flakyCallCount = 0;
cli({
  site: 'cb-test',
  name: 'flaky',
  description: 'fails N times then succeeds',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'fail_times', type: 'int', default: 1 }],
  func: async (kwargs) => {
    flakyCallCount++;
    if (flakyCallCount <= Number(kwargs.fail_times)) {
      throw new Error(`flaky failure #${flakyCallCount}`);
    }
    return { ok: true };
  },
});

let consumerCallCount = 0;
cli({
  site: 'cb-test',
  name: 'consumer',
  description: 'spy adapter that records when invoked',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'input', type: 'string' }],
  func: async (kwargs) => {
    consumerCallCount++;
    return { got: kwargs.input };
  },
});

describe('dependency-skip precheck (skip propagation)', () => {
  it('skips a downstream consumer cleanly when its upstream is skipped, without invoking its adapter', async () => {
    const before = consumerCallCount;
    const def = {
      name: 'skip-propagation-test',
      steps: {
        // Always fails and is skipped under on_error: skip → `prod` never set.
        'producer': {
          type: 'adapter' as const,
          adapter: 'cb-test/flaky',
          args: { fail_times: 99 },
          on_error: 'skip' as const,
          output: 'prod',
        },
        // Consumes the skipped producer's output → precheck must skip it
        // rather than calling the consumer adapter with undefined.
        'consumer': {
          type: 'adapter' as const,
          adapter: 'cb-test/consumer',
          args: { input: '$prod' },
          depends_on: ['producer'],
        },
      },
      checkpoint: false,
    };

    const ended: { stepName: string; status: string; error?: string }[] = [];
    const callbacks: WorkflowCallbacks = {
      onStepEnd(e) { ended.push({ stepName: e.stepName, status: e.status, error: e.error }); },
    };

    const result = await executeWorkflow(def, {}, { callbacks });
    expect(result.skippedSteps).toContain('producer');
    expect(result.skippedSteps).toContain('consumer');
    // The consumer's adapter was never called — precheck skipped it before launch.
    expect(consumerCallCount).toBe(before);

    const consumerEnd = ended.find(e => e.stepName === 'consumer')!;
    expect(consumerEnd.status).toBe('skipped');
    expect(consumerEnd.error).toContain('dependency output not available: prod');
  });

  it('still runs a downstream step whose dependency was skipped but whose args do not reference it', async () => {
    // Pure ordering dependency: consumer depends_on producer for sequencing but
    // does not reference producer's (missing) output → precheck lets it run.
    const def = {
      name: 'skip-propagation-independent-test',
      steps: {
        'producer': {
          type: 'adapter' as const,
          adapter: 'cb-test/flaky',
          args: { fail_times: 99 },
          on_error: 'skip' as const,
          output: 'prod',
        },
        'independent': {
          type: 'adapter' as const,
          adapter: 'cb-test/echo',
          args: { value: 'ok' },
          depends_on: ['producer'],
        },
      },
      checkpoint: false,
    };

    const result = await executeWorkflow(def, {}, {});
    expect(result.skippedSteps).toContain('producer');
    expect(result.completedSteps).toContain('independent');
  });
});

describe('Workflow callback system', () => {
  describe('onStepStart / onStepEnd', () => {
    it('fires start and end events with correct status and timing', async () => {
      const started: string[] = [];
      const ended: { stepName: string; status: string }[] = [];

      const def = {
        name: 'callback-basic-test',
        steps: {
          's1': { type: 'adapter' as const, adapter: 'cb-test/echo', args: { value: 'hi' } },
        },
        checkpoint: false,
      };

      const callbacks: WorkflowCallbacks = {
        onStepStart(e) { started.push(e.stepName); },
        onStepEnd(e) { ended.push({ stepName: e.stepName, status: e.status }); },
      };

      const result = await executeWorkflow(def, {}, { callbacks });
      expect(result.status).toBe('completed');
      expect(started).toEqual(['s1']);
      expect(ended).toEqual([{ stepName: 's1', status: 'completed' }]);
    });

    it('fires onWorkflowStart / onWorkflowEnd', async () => {
      const events: string[] = [];
      const def = {
        name: 'workflow-lifecycle-test',
        steps: {
          's1': { type: 'adapter' as const, adapter: 'cb-test/echo', args: { value: 'hi' } },
        },
        checkpoint: false,
      };
      const callbacks: WorkflowCallbacks = {
        onWorkflowStart(e) { events.push(`start:${e.workflow}:${e.totalSteps}`); },
        onWorkflowEnd(e) { events.push(`end:${e.status}`); },
      };
      await executeWorkflow(def, {}, { callbacks });
      expect(events).toEqual(['start:workflow-lifecycle-test:1', 'end:completed']);
    });

    it('populates stepRecords with timing and status', async () => {
      const def = {
        name: 'step-records-test',
        steps: {
          's1': { type: 'adapter' as const, adapter: 'cb-test/echo', args: { value: 'hi' } },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      expect(result.stepRecords).toHaveLength(1);
      const record = result.stepRecords[0];
      expect(record.name).toBe('s1');
      expect(record.status).toBe('completed');
      expect(record.startedAt).toBeDefined();
      expect(record.finishedAt).toBeDefined();
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('onStepRetry', () => {
    it('fires during retry backoff with correct attempt/maxRetries', async () => {
      flakyCallCount = 0;
      const retries: { attempt: number; maxRetries: number }[] = [];
      const def = {
        name: 'retry-callback-test',
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'cb-test/flaky',
            args: { fail_times: 1 },
            on_error: 'retry' as const,
            retries: 2,
          },
        },
        checkpoint: false,
      };
      const callbacks: WorkflowCallbacks = {
        onStepRetry(e) { retries.push({ attempt: e.attempt, maxRetries: e.maxRetries }); },
      };
      const result = await executeWorkflow(def, {}, { callbacks });
      expect(result.status).toBe('completed');
      expect(retries).toEqual([{ attempt: 1, maxRetries: 2 }]);
      expect(result.stepRecords[0].retries).toBe(1);
    });
  });

  describe('onForeachProgress', () => {
    it('fires incrementally as foreach items complete', async () => {
      const progress: { completed: number; total: number }[] = [];
      const def = {
        name: 'foreach-progress-test',
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'cb-test/echo',
            foreach: '$items',
            concurrency: 1,
            args: { value: '$item.v' },
            output: 'results',
          },
        },
        checkpoint: false,
      };
      const callbacks: WorkflowCallbacks = {
        onForeachProgress(e) { progress.push({ completed: e.completed, total: e.total }); },
      };
      const result = await executeWorkflow(def, { items: [{ v: 'a' }, { v: 'b' }, { v: 'c' }] }, { callbacks });
      expect(result.status).toBe('completed');
      expect(progress.map(p => p.completed)).toEqual([1, 2, 3]);
      expect(progress.every(p => p.total === 3)).toBe(true);
    });
  });

  describe('onInteract: confirm gate', () => {
    it('proceeds to adapter when confirm resolves true', async () => {
      const def = {
        name: 'confirm-approve-test',
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'cb-test/echo',
            confirm: 'proceed?',
            args: { value: 'ran' },
          },
        },
        checkpoint: false,
      };
      const callbacks: WorkflowCallbacks = { onInteract: async () => true };
      const result = await executeWorkflow(def, {}, { callbacks });
      expect(result.status).toBe('completed');
      expect(result.skippedSteps).toEqual([]);
      expect((result.context.s1 as { value: string }).value).toBe('ran');
    });

    it('skips the step when confirm resolves false', async () => {
      const def = {
        name: 'confirm-decline-test',
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'cb-test/echo',
            confirm: 'proceed?',
            args: { value: 'should-not-run' },
          },
        },
        checkpoint: false,
      };
      const callbacks: WorkflowCallbacks = { onInteract: async () => false };
      const result = await executeWorkflow(def, {}, { callbacks });
      expect(result.status).toBe('completed');
      expect(result.skippedSteps).toEqual(['s1']);
      expect(result.context.s1).toBeUndefined();
    });

    it('auto-approves when no onInteract callback is provided', async () => {
      const def = {
        name: 'confirm-fallback-test',
        steps: {
          's1': { type: 'adapter' as const, adapter: 'cb-test/echo', confirm: true, args: { value: 'ran' } },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      expect(result.status).toBe('completed');
      expect(result.skippedSteps).toEqual([]);
    });
  });

  describe('onInteract: select / multi-select', () => {
    it('select resolves value from `from` array and applies output.map', async () => {
      const receivedSpecs: ResolvedInteractSpec[] = [];
      const def = {
        name: 'select-test',
        steps: {
          'choose': {
            interact: {
              type: 'select' as const,
              from: '$shops',
              display: 'name',
              message: '选择店铺',
            },
            output: { as: 'target_shop', map: { shop_name: 'name', shop_id: 'id' } },
          },
        },
        checkpoint: false,
      };
      const callbacks: WorkflowCallbacks = {
        onInteract: async (_stepName, spec) => {
          receivedSpecs.push(spec);
          if (spec.type === 'select') return spec.options[1].value;
          return undefined;
        },
      };
      const result = await executeWorkflow(def, {
        shops: [{ name: 'Store A', id: 1 }, { name: 'Store B', id: 2 }],
      }, { callbacks });

      expect(result.status).toBe('completed');
      expect(receivedSpecs[0].type).toBe('select');
      expect(result.context.target_shop).toEqual({ shop_name: 'Store B', shop_id: 2 });
    });

    it('multi-select fallback returns all items when no callback provided', async () => {
      const def = {
        name: 'multi-select-fallback-test',
        steps: {
          'choose': {
            interact: {
              type: 'multi-select' as const,
              from: '$products',
              display: 'name',
              message: '选择产品',
            },
            output: 'selected_products',
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {
        products: [{ name: 'A' }, { name: 'B' }],
      });
      expect(result.status).toBe('completed');
      expect(result.context.selected_products).toEqual([{ name: 'A' }, { name: 'B' }]);
    });
  });

  describe('onInteract: input', () => {
    it('stores user text input into the output variable', async () => {
      const def = {
        name: 'input-test',
        steps: {
          'enter': {
            interact: { type: 'input' as const, message: '输入关键词', default: 'electronics' },
            output: 'keyword',
          },
        },
        checkpoint: false,
      };
      const callbacks: WorkflowCallbacks = { onInteract: async () => 'custom-keyword' };
      const result = await executeWorkflow(def, {}, { callbacks });
      expect(result.status).toBe('completed');
      expect(result.context.keyword).toBe('custom-keyword');
    });

    it('falls back to default when no callback provided', async () => {
      const def = {
        name: 'input-fallback-test',
        steps: {
          'enter': {
            interact: { type: 'input' as const, message: '输入关键词', default: 'electronics' },
            output: 'keyword',
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      expect(result.context.keyword).toBe('electronics');
    });
  });

  describe('mergeCallbacks', () => {
    it('fans events out to every provided callback set', async () => {
      const a: string[] = [];
      const b: string[] = [];
      const def = {
        name: 'merge-callbacks-test',
        steps: {
          's1': { type: 'adapter' as const, adapter: 'cb-test/echo', args: { value: 'hi' } },
        },
        checkpoint: false,
      };
      const merged = mergeCallbacks(
        { onStepEnd: (e) => a.push(e.stepName) },
        { onStepEnd: (e) => b.push(e.stepName) },
      );
      await executeWorkflow(def, {}, { callbacks: merged });
      expect(a).toEqual(['s1']);
      expect(b).toEqual(['s1']);
    });

    it('returns the sole callback set unchanged when only one is given', () => {
      const cb: WorkflowCallbacks = { onStepEnd: () => {} };
      expect(mergeCallbacks(cb)).toBe(cb);
    });

    it('returns an empty object when none are given', () => {
      expect(mergeCallbacks(undefined, null)).toEqual({});
    });
  });

  describe('parser: interact / confirm YAML', () => {
    function writeTmpYaml(content: string): string {
      const tmpPath = path.join(os.tmpdir(), `interact-parse-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
      fs.writeFileSync(tmpPath, content);
      return tmpPath;
    }

    it('parses a pure select interact step without requiring an adapter', () => {
      const tmpPath = writeTmpYaml(`
name: select-parse-test
steps:
  choose:
    interact:
      type: select
      from: $shops
      display: name
      message: "选择店铺"
    output: target_shop
`);
      try {
        const def = parseWorkflow(tmpPath);
        expect(def.steps.choose.adapter).toBeUndefined();
        expect(def.steps.choose.interact).toEqual({
          type: 'select', from: '$shops', display: 'name', message: '选择店铺',
        });
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('parses a pure input interact step without requiring an adapter', () => {
      const tmpPath = writeTmpYaml(`
name: input-parse-test
steps:
  enter:
    interact:
      type: input
      message: "输入关键词"
      default: "electronics"
    output: keyword
`);
      try {
        const def = parseWorkflow(tmpPath);
        expect(def.steps.enter.adapter).toBeUndefined();
        expect(def.steps.enter.interact).toEqual({ type: 'input', message: '输入关键词', default: 'electronics' });
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('parses confirm shorthand on an adapter step', () => {
      const tmpPath = writeTmpYaml(`
name: confirm-shorthand-test
steps:
  deploy:
    adapter: cb-test/echo
    confirm: "Deploy to production?"
    args:
      value: go
`);
      try {
        const def = parseWorkflow(tmpPath);
        expect(def.steps.deploy.confirm).toBe('Deploy to production?');
        expect(def.steps.deploy.adapter).toBe('cb-test/echo');
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('allows interact.type confirm without adapter (pure confirm produces output)', () => {
      const tmpPath = writeTmpYaml(`
name: confirm-interact-no-adapter-test
steps:
  gate:
    interact:
      type: confirm
      message: "proceed?"
    output: confirmed
`);
      try {
        const def = parseWorkflow(tmpPath);
        expect(def.steps.gate.interact?.type).toBe('confirm');
        expect(def.steps.gate.adapter).toBeUndefined();
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('rejects an interact block with an unknown type', () => {
      const tmpPath = writeTmpYaml(`
name: bad-interact-type-test
steps:
  choose:
    interact:
      type: not-a-real-type
      message: "hmm"
    output: x
`);
      try {
        expect(() => parseWorkflow(tmpPath)).toThrow(WorkflowParseError);
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });

    it('end-to-end: pure select step executes and feeds a downstream adapter step', async () => {
      const tmpPath = writeTmpYaml(`
name: select-e2e-test
steps:
  choose:
    interact:
      type: select
      from: $shops
      display: name
      message: "选择店铺"
    output:
      as: target_shop
      map:
        shop_name: name
        shop_id: id
  notify:
    adapter: cb-test/echo
    args:
      value: '\${{ args.target_shop.shop_name }}'
    depends_on: [choose]
`);
      try {
        const def = parseWorkflow(tmpPath);
        const callbacks: WorkflowCallbacks = {
          onInteract: async (_stepName, spec) => {
            if (spec.type === 'select') return spec.options[1].value;
            return undefined;
          },
        };
        const result = await executeWorkflow(def, {
          shops: [{ name: 'Store A', id: 1 }, { name: 'Store B', id: 2 }],
        }, { callbacks });
        expect(result.status).toBe('completed');
        expect(result.context.target_shop).toEqual({ shop_name: 'Store B', shop_id: 2 });
        expect((result.context.notify as { value: string }).value).toBe('Store B');
      } finally {
        fs.unlinkSync(tmpPath);
      }
    });
  });
});

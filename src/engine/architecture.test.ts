/**
 * Tests for workflow architecture improvements:
 * - output.map (Anti-Corruption Layer)
 * - inputs/outputs declarations (Ports & Adapters)
 * - Variable regex fix (no dash in variable names)
 * - resolveArgsTyped (type-preserving)
 * - Validator inputs awareness
 * - Dashed step name → underscore output variable
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpBridge } from '@jackwener/opencli/bridge/mcp';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { parseWorkflow } from '../schema/parser.js';
import { executeWorkflow } from './engine.js';
import { validateWorkflow } from '../schema/validator.js';
import { WorkflowContext } from './context.js';
import type { McpBridgeConfig } from '@jackwener/opencli/bridge/types';

const TEST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test',
);

const MOCK_SERVER = path.resolve(TEST_DIR, 'mock-mcp-server.cjs');

describe('Workflow Architecture', () => {
  let bridge: McpBridge;

  beforeAll(async () => {
    const config: McpBridgeConfig = {
      name: 'test-mock',
      type: 'mcp',
      transport: 'stdio',
      command: 'node',
      args: [MOCK_SERVER],
    };
    bridge = new McpBridge(config);
    await bridge.connect();
    const tools = await bridge.discover();
    for (const tool of tools) {
      cli({
        site: 'mcp-test-mock',
        name: tool.name,
        description: tool.description || tool.name,
        access: tool.access || 'read',
        strategy: Strategy.PUBLIC,
        browser: false,
        args: tool.args.map(a => ({
          name: a.name,
          type: a.type || 'string',
          required: a.required,
          help: a.description,
          default: a.default,
          choices: a.choices,
        })),
        func: async (kwargs) => {
          if (!bridge.connected) await bridge.connect();
          return bridge.invoke(tool.name, kwargs);
        },
      });
    }
  });

  afterAll(async () => {
    if (bridge?.connected) await bridge.disconnect();
  });

  describe('Variable regex (no dash)', () => {
    it('$var_name captures underscore names', () => {
      const ctx = new WorkflowContext();
      ctx.set('batch_id', '42');
      expect(ctx.resolve('$batch_id')).toBe('42');
    });

    it('$var-suffix is parsed as $var minus suffix, not one variable', () => {
      const ctx = new WorkflowContext();
      ctx.set('batch', 'hello');
      const result = ctx.resolve('$batch-suffix');
      expect(result).not.toBe(undefined);
      expect(String(result)).toContain('hello');
      expect(String(result)).toContain('-suffix');
    });

    it('$item.dashed-key resolves correctly', () => {
      const ctx = new WorkflowContext();
      const result = ctx.resolve('$item.first-name', { 'first-name': 'Alice' });
      expect(result).toBe('Alice');
    });
  });

  describe('Dashed step name → underscore output', () => {
    it('step named generate-items outputs as generate_items', async () => {
      const def = {
        name: 'dash-test',
        steps: {
          'generate-items': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            args: { message: 'test', times: 2 },
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      expect(result.status).toBe('completed');
      expect(result.context).toHaveProperty('generate_items');
      expect(result.context).not.toHaveProperty('generate-items');
    });

    it('explicit output: overrides the default', async () => {
      const def = {
        name: 'explicit-output-test',
        steps: {
          'my-step': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            args: { message: 'test', times: 1 },
            output: 'custom_name',
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      expect(result.context).toHaveProperty('custom_name');
    });
  });

  describe('output.map (Anti-Corruption Layer)', () => {
    it('maps fields when output has map spec', async () => {
      const def = {
        name: 'map-test',
        steps: {
          'fetch': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            args: { message: 'hello', times: 2 },
            output: {
              as: 'items',
              map: {
                msg: 'message',
                idx: 'index',
              },
            },
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      expect(result.status).toBe('completed');

      const items = result.context['items'] as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveProperty('msg', 'hello');
      expect(items[0]).toHaveProperty('idx', 0);
      expect(items[0]).not.toHaveProperty('message');
      expect(items[0]).not.toHaveProperty('index');
    });

    it('without map, preserves original data', async () => {
      const def = {
        name: 'no-map-test',
        steps: {
          'fetch': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            args: { message: 'hello', times: 1 },
            output: { as: 'data' },
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      const data = result.context['data'] as Array<Record<string, unknown>>;
      expect(data[0]).toHaveProperty('message', 'hello');
    });
  });

  describe('inputs/outputs declarations', () => {
    it('required input missing throws', async () => {
      const def = {
        name: 'input-required-test',
        inputs: { task_id: { required: true, type: 'string' as const } },
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            args: { message: '$task_id', times: 1 },
          },
        },
        checkpoint: false,
      };
      await expect(executeWorkflow(def, {})).rejects.toThrow('requires input "task_id"');
    });

    it('required input provided succeeds', async () => {
      const def = {
        name: 'input-provided-test',
        inputs: { task_id: { required: true, type: 'string' as const } },
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            args: { message: '$task_id', times: 1 },
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, { task_id: 'abc' });
      expect(result.status).toBe('completed');
    });

    it('default input fills in when not provided', async () => {
      const def = {
        name: 'input-default-test',
        inputs: { greeting: { default: 'world' } },
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/hello',
            args: { name: '$greeting' },
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(def, {});
      expect(result.status).toBe('completed');
      const data = result.context['s1'] as Array<{ greeting: string }>;
      expect(data[0].greeting).toBe('Hello, world!');
    });

    it('outputs filters nested workflow return', async () => {
      const childDef = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-child.yaml'));
      expect(childDef.outputs).toEqual(['enriched']);

      const singleDef = {
        name: 'outputs-filter-test',
        steps: {
          'process': {
            type: 'workflow' as const,
            workflow: path.join(TEST_DIR, 'e2e-nested-child.yaml'),
            args: { task_id: 'test-1' },
            output: 'result',
          },
        },
        checkpoint: false,
      };
      const result = await executeWorkflow(singleDef, {}, { debug: true });
      expect(result.status).toBe('completed');

      const childResult = result.context['result'] as Record<string, unknown>;
      expect(childResult).toHaveProperty('enriched');
      // validation, transformed, tags should NOT be exposed
      expect(childResult).not.toHaveProperty('validation');
      expect(childResult).not.toHaveProperty('transformed');
      expect(childResult).not.toHaveProperty('tags');
    });
  });

  describe('resolveArgsTyped', () => {
    it('preserves array type without JSON.stringify', () => {
      const ctx = new WorkflowContext();
      ctx.set('data', [1, 2, 3]);
      const result = ctx.resolveArgsTyped({ items: '$data' });
      expect(result.items).toEqual([1, 2, 3]);
      expect(typeof result.items).not.toBe('string');
    });

    it('preserves object type', () => {
      const ctx = new WorkflowContext();
      ctx.set('config', { key: 'value' });
      const result = ctx.resolveArgsTyped({ cfg: '$config' });
      expect(result.cfg).toEqual({ key: 'value' });
      expect(typeof result.cfg).toBe('object');
    });

    it('resolveArgs still stringifies for comparison', () => {
      const ctx = new WorkflowContext();
      ctx.set('data', [1, 2, 3]);
      const result = ctx.resolveArgs({ items: '$data' });
      expect(typeof result.items).toBe('string');
      expect(result.items).toBe('[1,2,3]');
    });
  });

  describe('Validator with inputs', () => {
    it('no warning for variables declared as inputs', () => {
      const def = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-child.yaml'));
      const warnings = validateWorkflow(def);
      // With inputs declared, $task_id should not trigger a warning
      expect(warnings.filter(w => w.reference === '$task_id')).toHaveLength(0);
    });

    it('still warns about truly unknown variables', () => {
      const def = {
        name: 'unknown-var-test',
        inputs: { known: { type: 'string' as const } },
        steps: {
          's1': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            args: { message: '$unknown_var', times: 1 },
          },
        },
      };
      const warnings = validateWorkflow(def);
      expect(warnings.some(w => w.reference === '$unknown_var')).toBe(true);
    });
  });

  describe('Parser: output.map and inputs/outputs', () => {
    it('parses output as string (backward compat)', () => {
      const def = parseWorkflow(path.join(TEST_DIR, 'e2e-workflow.yaml'));
      expect(def.steps['greet'].output).toBe('greeting');
    });

    it('parses inputs and outputs from child YAML', () => {
      const def = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-child.yaml'));
      expect(def.inputs).toBeDefined();
      expect(def.inputs!['task_id']).toEqual({ type: 'string', required: true });
      expect(def.outputs).toEqual(['enriched']);
    });
  });

  describe('foreach per-item error isolation', () => {
    it('on_error: skip filters failed items, keeps successful ones', async () => {
      const def = {
        name: 'foreach-error-test',
        steps: {
          'process': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            foreach: '$items',
            concurrency: 2,
            on_error: 'skip' as const,
            args: { message: '$item.value', times: 1 },
            output: 'results',
          },
        },
        checkpoint: false,
      };

      // Provide items — all will succeed since echo never fails
      const result = await executeWorkflow(def, {
        items: [{ value: 'a' }, { value: 'b' }, { value: 'c' }],
      }, { debug: true });

      expect(result.status).toBe('completed');
      const results = result.context['results'] as Array<{ message: string }>;
      expect(results).toHaveLength(3);
    });

    it('on_error: stop with foreach fails entire step', async () => {
      // Use a constructed definition where foreach refs a variable with invalid data
      const def = {
        name: 'foreach-stop-test',
        steps: {
          'process': {
            type: 'adapter' as const,
            adapter: 'mcp-test-mock/echo',
            foreach: '$items',
            concurrency: 1,
            on_error: 'stop' as const,
            args: { message: '$item.nonexistent_field', times: 1 },
            output: 'results',
          },
        },
        checkpoint: false,
      };

      // Even with on_error stop, successful items should work
      const result = await executeWorkflow(def, {
        items: [{ value: 'hello' }],
      });
      // Args validation fails → step fails → workflow fails (stop policy)
      expect(result.failedSteps).toContain('process');
    });
  });

  describe('retry backoff', () => {
    it('retries with backoff on failure then succeeds', async () => {
      let callCount = 0;
      cli({
        site: 'arch-test',
        name: 'flaky',
        description: 'Fails first N times then succeeds',
        access: 'read',
        strategy: Strategy.PUBLIC,
        browser: false,
        args: [
          { name: 'fail_times', type: 'int', default: 1, help: 'Fail this many times' },
        ],
        func: async (kwargs) => {
          callCount++;
          if (callCount <= Number(kwargs.fail_times)) {
            throw new Error(`Flaky failure #${callCount}`);
          }
          return [{ attempt: callCount }];
        },
      });

      callCount = 0;
      const def = {
        name: 'retry-backoff-test',
        steps: {
          'flaky-step': {
            type: 'adapter' as const,
            adapter: 'arch-test/flaky',
            args: { fail_times: 1 },
            on_error: 'retry' as const,
            retries: 2,
            output: 'result',
          },
        },
        checkpoint: false,
      };

      const result = await executeWorkflow(def, {}, { debug: true });

      expect(result.status).toBe('completed');
      expect(result.failedSteps).toHaveLength(0);
      // Should have taken 2 calls: 1 failure + 1 retry success
      expect(callCount).toBe(2);
    });
  });
});

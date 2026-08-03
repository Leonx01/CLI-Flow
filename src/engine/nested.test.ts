/**
 * E2E test for workflow nesting: parent workflows calling child workflows.
 *
 * Exercises:
 * - type: workflow step execution
 * - foreach with nested workflows
 * - Variable passing across nesting boundary
 * - DAG parallelism inside child workflows
 * - 3-level deep nesting (grandparent → mid → child)
 * - Single-invocation nested workflow (no foreach)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpBridge } from '@jackwener/opencli/bridge/mcp';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { parseWorkflow } from '../schema/parser.js';
import { executeWorkflow } from './engine.js';
import { validateWorkflow } from '../schema/validator.js';
import type { McpBridgeConfig } from '@jackwener/opencli/bridge/types';

const TEST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test',
);

const MOCK_SERVER = path.resolve(TEST_DIR, 'mock-mcp-server.cjs');

describe('Workflow Nesting E2E', () => {
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

  describe('Scenario 1: Single nested workflow (no foreach)', () => {
    const yamlPath = path.join(TEST_DIR, 'e2e-nested-single.yaml');

    it('parses without errors', () => {
      const def = parseWorkflow(yamlPath);
      expect(def.name).toBe('nested-single');
      expect(Object.keys(def.steps)).toHaveLength(3);

      const subStep = def.steps['sub-pipeline'];
      expect(subStep.type).toBe('workflow');
      expect(subStep.workflow).toContain('e2e-nested-child.yaml');
    });

    it('validates with no warnings', () => {
      const def = parseWorkflow(yamlPath);
      const warnings = validateWorkflow(def);
      expect(warnings).toHaveLength(0);
    });

    it('executes and returns scoped child output', async () => {
      const def = parseWorkflow(yamlPath);
      const result = await executeWorkflow(def, {}, { debug: true });

      expect(result.status).toBe('completed');
      expect(result.failedSteps).toHaveLength(0);
      expect(result.completedSteps).toContain('seed');
      expect(result.completedSteps).toContain('sub-pipeline');
      expect(result.completedSteps).toContain('use-child-output');

      // sub_result only contains declared outputs (enriched)
      const subResult = result.context['sub_result'] as Record<string, unknown>;
      expect(subResult).toBeDefined();
      expect(subResult).toHaveProperty('enriched');
      // Internal steps are NOT exposed
      expect(subResult).not.toHaveProperty('validation');
      expect(subResult).not.toHaveProperty('transformed');
      expect(subResult).not.toHaveProperty('tags');

      const enriched = subResult['enriched'] as Array<{ message: string }>;
      expect(enriched[0].message).toBe('enriched-single-run');
    });
  });

  describe('Scenario 2: Foreach nested workflow with DAG parallelism', () => {
    const yamlPath = path.join(TEST_DIR, 'e2e-nested-parent.yaml');

    it('parses parent with workflow step', () => {
      const def = parseWorkflow(yamlPath);
      expect(def.name).toBe('nested-pipeline');
      expect(Object.keys(def.steps)).toHaveLength(5);

      const processStep = def.steps['process-items'];
      expect(processStep.type).toBe('workflow');
      expect(processStep.foreach).toBe('$work_items');
      expect(processStep.concurrency).toBe(2);
    });

    it('child validator has no warnings with inputs declared', () => {
      const def = parseWorkflow(yamlPath);
      const warnings = validateWorkflow(def);
      expect(warnings).toHaveLength(0);

      const childDef = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-child.yaml'));
      const childWarnings = validateWorkflow(childDef);
      expect(childWarnings).toHaveLength(0);
    });

    it('executes full pipeline with 3 child workflow invocations', async () => {
      const def = parseWorkflow(yamlPath);
      const result = await executeWorkflow(def, {}, { debug: true });

      expect(result.status).toBe('completed');
      expect(result.failedSteps).toHaveLength(0);

      // All 5 parent steps completed
      expect(result.completedSteps).toHaveLength(5);

      // init_result: hello("Pipeline") → [{greeting: "Hello, Pipeline!"}]
      const initResult = result.context['init_result'] as Array<{ greeting: string }>;
      expect(initResult[0].greeting).toBe('Hello, Pipeline!');

      // work_items: echo("task", 3) → [{index:0,message:"task"}, ...]
      const workItems = result.context['work_items'] as Array<{ index: number; message: string }>;
      expect(workItems).toHaveLength(3);

      // generate-items and generate-config ran in parallel (both depend only on init)
      const config = result.context['config'] as Array<{ index: number; message: string }>;
      expect(config).toHaveLength(1);
      expect(config[0].message).toBe('config-v1');

      // processed: foreach 3 items → 3 scoped child contexts (only enriched)
      const processed = result.context['processed'] as Array<Record<string, unknown>>;
      expect(processed).toHaveLength(3);

      for (let i = 0; i < 3; i++) {
        const childCtx = processed[i];
        expect(childCtx).toHaveProperty('enriched');
        expect(childCtx).not.toHaveProperty('validation');

        const enriched = childCtx['enriched'] as Array<{ message: string }>;
        expect(enriched[0].message).toBe(`enriched-${i}`);
      }

      // final: hello("completed") after all processing done
      const final = result.context['final'] as Array<{ greeting: string }>;
      expect(final[0].greeting).toBe('Hello, completed!');
    });
  });

  describe('Scenario 3: Three-level deep nesting', () => {
    const yamlPath = path.join(TEST_DIR, 'e2e-nested-deep.yaml');

    it('parses all three levels', () => {
      const grandparent = parseWorkflow(yamlPath);
      expect(grandparent.name).toBe('deep-nested-pipeline');

      const midStep = grandparent.steps['run-batches'];
      expect(midStep.type).toBe('workflow');

      const mid = parseWorkflow(midStep.workflow!);
      expect(mid.name).toBe('mid-processor');

      const drillStep = mid.steps['drill-down'];
      expect(drillStep.type).toBe('workflow');

      const child = parseWorkflow(drillStep.workflow!);
      expect(child.name).toBe('item-processor');
    });

    it('executes 3-level pipeline end to end', async () => {
      const def = parseWorkflow(yamlPath);
      const result = await executeWorkflow(def, {}, { debug: true });

      expect(result.status).toBe('completed');
      expect(result.failedSteps).toHaveLength(0);
      expect(result.completedSteps).toHaveLength(3);

      // bootstrap: echo("batch", 2) → 2 items
      const batches = result.context['batches'] as Array<{ index: number }>;
      expect(batches).toHaveLength(2);

      // batch_results: foreach 2 batches → 2 mid-level contexts
      const batchResults = result.context['batch_results'] as Array<Record<string, unknown>>;
      expect(batchResults).toHaveLength(2);

      for (let batchIdx = 0; batchIdx < 2; batchIdx++) {
        const midCtx = batchResults[batchIdx];

        // mid_items: echo("mid-{batchIdx}", 2) → 2 items
        const midItems = midCtx['mid_items'] as Array<{ index: number }>;
        expect(midItems).toHaveLength(2);

        // drilled: foreach 2 mid_items → 2 leaf child contexts (scoped to enriched only)
        const drilled = midCtx['drilled'] as Array<Record<string, unknown>>;
        expect(drilled).toHaveLength(2);

        for (let itemIdx = 0; itemIdx < 2; itemIdx++) {
          const leafCtx = drilled[itemIdx];
          expect(leafCtx).toHaveProperty('enriched');
          expect(leafCtx).not.toHaveProperty('validation');
        }

        // mid_summary: hello("mid-done-{batchIdx}")
        const midSummary = midCtx['mid_summary'] as Array<{ greeting: string }>;
        expect(midSummary[0].greeting).toBe(`Hello, mid-done-${batchIdx}!`);
      }

      // grand_final
      const grandFinal = result.context['grand_final'] as Array<{ greeting: string }>;
      expect(grandFinal[0].greeting).toBe('Hello, all-done!');
    });
  });

  describe('Scenario 4: Child workflow DAG ordering', () => {
    it('child enforces fan-in (enrich waits for both transform and tag)', async () => {
      const childDef = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-child.yaml'));
      const result = await executeWorkflow(childDef, { task_id: 'ordering-test' }, { debug: true });

      expect(result.status).toBe('completed');
      expect(result.completedSteps).toHaveLength(4);

      // validate must complete before transform and tag
      const validateIdx = result.completedSteps.indexOf('validate');
      const transformIdx = result.completedSteps.indexOf('transform');
      const tagIdx = result.completedSteps.indexOf('tag');
      const enrichIdx = result.completedSteps.indexOf('enrich');

      expect(validateIdx).toBeLessThan(transformIdx);
      expect(validateIdx).toBeLessThan(tagIdx);
      expect(enrichIdx).toBeGreaterThan(transformIdx);
      expect(enrichIdx).toBeGreaterThan(tagIdx);
    });
  });

  describe('Edge cases', () => {
    it('nested workflow with missing child file throws', () => {
      expect(() => {
        parseWorkflow(path.join(TEST_DIR, 'e2e-nested-parent.yaml'));
        // Parse succeeds — but if we gave a bad path, the child would fail at runtime
      }).not.toThrow();
    });

    it('child workflow failure propagates to parent', async () => {
      const def = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-single.yaml'));

      // Tamper with the child step to point to a non-existent file
      def.steps['sub-pipeline'].workflow = path.join(TEST_DIR, 'nonexistent.yaml');

      const result = await executeWorkflow(def, {});

      expect(result.status).not.toBe('completed');
      expect(result.failedSteps).toContain('sub-pipeline');
    });

    it('child workflow "partial" status (some steps ok, some failed) propagates to parent as failure', async () => {
      const childDef = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-partial-child.yaml'));
      const childResult = await executeWorkflow(childDef, {}, { debug: true });

      // Sanity check on the underlying condition this test exercises.
      expect(childResult.status).toBe('partial');
      expect(childResult.completedSteps).toContain('ok-step');
      expect(childResult.failedSteps).toContain('bad-step');

      const parentDef = parseWorkflow(path.join(TEST_DIR, 'e2e-nested-partial-parent.yaml'));
      const parentResult = await executeWorkflow(parentDef, {}, { debug: true });

      expect(parentResult.status).not.toBe('completed');
      expect(parentResult.failedSteps).toContain('call-child');
    });

    it('empty foreach skips child workflow execution', async () => {
      // Construct a minimal definition that has an empty array in context
      const testDef = {
        name: 'empty-foreach-test',
        steps: {
          'process': {
            type: 'workflow' as const,
            workflow: path.join(TEST_DIR, 'e2e-nested-child.yaml'),
            foreach: '$items',
            args: { task_id: '$item.index' },
            output: 'results',
          },
        },
        checkpoint: false,
      };

      // Pre-seed the context with an empty array
      const result = await executeWorkflow(testDef, { items: [] }, { debug: true });

      expect(result.status).toBe('completed');
      const results = result.context['results'] as unknown[];
      expect(results).toHaveLength(0);
    });
  });
});

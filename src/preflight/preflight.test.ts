import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { McpBridge } from '@jackwener/opencli/bridge/mcp';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { preflightWorkflow } from './preflight.js';
import type { McpBridgeConfig } from '@jackwener/opencli/bridge/types';

const TEST_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../test',
);
const MOCK_SERVER = path.resolve(TEST_DIR, 'mock-mcp-server.cjs');

describe('Workflow Preflight', () => {
  let bridge: McpBridge;

  beforeAll(async () => {
    const config: McpBridgeConfig = {
      name: 'test-preflight',
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
        func: async (kwargs) => bridge.invoke(tool.name, kwargs),
      });
    }
  });

  afterAll(async () => {
    if (bridge?.connected) await bridge.disconnect();
  });

  it('passes preflight for valid workflow', async () => {
    const result = await preflightWorkflow(path.join(TEST_DIR, 'e2e-workflow.yaml'));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.checks.some(c => c.category === 'parse' && c.status === 'pass')).toBe(true);
    expect(result.checks.some(c => c.category === 'dag' && c.status === 'pass')).toBe(true);
  });

  it('passes preflight for nested workflow', async () => {
    const result = await preflightWorkflow(path.join(TEST_DIR, 'e2e-nested-single.yaml'));
    expect(result.valid).toBe(true);
    expect(result.checks.some(c => c.category === 'nested' && c.status === 'pass')).toBe(true);
  });

  it('fails on nonexistent YAML file', async () => {
    const result = await preflightWorkflow(path.join(TEST_DIR, 'nonexistent.yaml'));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.checks[0].category).toBe('parse');
    expect(result.checks[0].status).toBe('fail');
  });

  it('detects missing adapter', async () => {
    const fs = await import('node:fs');
    const tmpPath = path.join(TEST_DIR, '_preflight-test-tmp.yaml');
    fs.writeFileSync(tmpPath, `name: bad-adapter-test\nsteps:\n  s1:\n    adapter: nonexistent/command\n    args:\n      query: test\n`);
    try {
      const result = await preflightWorkflow(tmpPath);
      expect(result.valid).toBe(false);
      expect(result.checks.some(c => c.category === 'adapter' && c.status === 'fail')).toBe(true);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('warns about undeclared args', async () => {
    const fs = await import('node:fs');
    const tmpPath = path.join(TEST_DIR, '_preflight-args-tmp.yaml');
    fs.writeFileSync(tmpPath, `name: bad-args-test\nsteps:\n  s1:\n    adapter: mcp-test-mock/echo\n    args:\n      message: hello\n      times: 1\n      unknown_arg: value\n`);
    try {
      const result = await preflightWorkflow(tmpPath);
      expect(result.warnings.some(w => w.includes('unknown_arg'))).toBe(true);
      expect(result.checks.some(c => c.category === 'args' && c.status === 'warn')).toBe(true);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('rejects deprecated type: ai with migration message', async () => {
    const fs = await import('node:fs');
    const tmpPath = path.join(TEST_DIR, '_preflight-ai-tmp.yaml');
    fs.writeFileSync(tmpPath, `name: ai-env-test\nsteps:\n  s1:\n    type: ai\n    prompt: test prompt\n    output: result\n`);
    try {
      const result = await preflightWorkflow(tmpPath);
      expect(result.valid).toBe(false);
      expect(result.checks[0].status).toBe('fail');
      expect(result.checks[0].message).toContain('removed');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('detects missing nested workflow file', async () => {
    const fs = await import('node:fs');
    const tmpPath = path.join(TEST_DIR, '_preflight-nested-tmp.yaml');
    const childPath = path.join(TEST_DIR, 'nonexistent-child.yaml');
    fs.writeFileSync(tmpPath, `name: missing-nested-test\nsteps:\n  s1:\n    type: workflow\n    workflow: ${childPath}\n    args:\n      id: test\n    output: result\n`);
    try {
      const result = await preflightWorkflow(tmpPath);
      expect(result.valid).toBe(false);
      expect(result.checks.some(c => c.category === 'nested' && c.status === 'fail')).toBe(true);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('returns probes for adapter steps', async () => {
    const result = await preflightWorkflow(path.join(TEST_DIR, 'e2e-workflow.yaml'));
    expect(result.probes.length).toBeGreaterThan(0);
    for (const probe of result.probes) {
      expect(probe.adapter).toBeDefined();
      expect(probe.strategy).toBeDefined();
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpBridge } from '@jackwener/opencli/bridge/mcp';
import { cli, Strategy, getRegistry } from '@jackwener/opencli/registry';
import { probeAdapter, probeAdapters } from './probe.js';
import type { McpBridgeConfig } from '@jackwener/opencli/bridge/types';
import type { CliCommand } from '@jackwener/opencli/registry';

const TEST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test',
);
const MOCK_SERVER = path.resolve(TEST_DIR, 'mock-mcp-server.cjs');

describe('Adapter Probe', () => {
  let bridge: McpBridge;

  beforeAll(async () => {
    const config: McpBridgeConfig = {
      name: 'test-probe',
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
        site: 'probe-test',
        name: tool.name,
        description: tool.description || tool.name,
        access: tool.access || 'read',
        strategy: Strategy.PUBLIC,
        browser: false,
        domain: 'example.com',
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

    cli({
      site: 'probe-test-local',
      name: 'noop',
      description: 'A local adapter for testing',
      access: 'read',
      strategy: Strategy.LOCAL,
      browser: false,
      args: [],
      func: async () => [{ status: 'ok' }],
    });
  });

  afterAll(async () => {
    if (bridge?.connected) await bridge.disconnect();
  });

  describe('probeAdapter', () => {
    it('LOCAL adapter returns ok immediately', async () => {
      const cmd = getRegistry().get('probe-test-local/noop')!;
      const result = await probeAdapter(cmd);
      expect(result.status).toBe('ok');
      expect(result.strategy).toBe('local');
      expect(result.latencyMs).toBeUndefined();
    });

    it('PUBLIC adapter with valid domain probes HTTP HEAD', async () => {
      const cmd = getRegistry().get('probe-test/echo')!;
      const result = await probeAdapter(cmd);
      expect(result.adapter).toBe('probe-test/echo');
      expect(result.strategy).toBe('public');
      expect(['ok', 'unreachable', 'timeout']).toContain(result.status);
      expect(result.latencyMs).toBeDefined();
    });

    it('returns columns and args metadata', async () => {
      const cmd = getRegistry().get('probe-test/echo')!;
      const result = await probeAdapter(cmd);
      expect(result.args).toContain('message');
    });

    it('COOKIE adapter without daemon returns no-bridge', async () => {
      const cookieCmd: CliCommand = {
        site: 'probe-cookie-test',
        name: 'need-login',
        description: 'Needs browser login',
        access: 'read',
        strategy: Strategy.COOKIE,
        browser: true,
        domain: 'example.com',
        args: [],
      };
      const result = await probeAdapter(cookieCmd);
      expect(result.status).toBe('no-bridge');
      expect(result.issue).toBeDefined();
    });
  });

  describe('probeAdapters', () => {
    it('returns not-found for unknown adapter', async () => {
      const results = await probeAdapters('nonexistent/adapter');
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('not-found');
    });

    it('returns not-found for unknown site', async () => {
      const results = await probeAdapters('nonexistent-site');
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('not-found');
    });

    it('probes all adapters in a site', async () => {
      const results = await probeAdapters('probe-test');
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.adapter).toMatch(/^probe-test\//);
      }
    });

    it('filters by strategy', async () => {
      const results = await probeAdapters('probe-test-local', { strategy: 'local' });
      expect(results).toHaveLength(1);
      expect(results[0].strategy).toBe('local');
      expect(results[0].status).toBe('ok');
    });

    it('caches domain probes for same domain', async () => {
      const results = await probeAdapters('probe-test');
      expect(results.length).toBeGreaterThan(1);
      // All share domain 'example.com': all should have the same status
      const statuses = new Set(results.map(r => r.status));
      expect(statuses.size).toBe(1);
    });
  });
});

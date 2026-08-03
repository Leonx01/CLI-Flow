#!/usr/bin/env node
/**
 * Mock MCP server (stdio) for CLI-Flow tests.
 * Zero-dependency: minimal MCP JSON-RPC 2.0 over stdio.
 *
 * Tools:
 *   hello(name: string)                -> [{ greeting: "Hello, <name>!" }]
 *   echo(message: string, times?: int) -> [{ index: 0, message }, ...]
 */
'use strict';

const readline = require('node:readline');

const TOOLS = [
  {
    name: 'hello',
    description: 'Greet someone by name',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to greet' },
      },
      required: ['name'],
    },
  },
  {
    name: 'echo',
    description: 'Echo a message N times',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo' },
        times: { type: 'integer', description: 'How many times to echo', default: 1 },
      },
      required: ['message'],
    },
  },
];

function handleCall(name, args) {
  const a = args || {};
  if (name === 'hello') {
    if (typeof a.name !== 'string' || a.name === '')
      throw new Error('hello: "name" (string) is required');
    return [{ greeting: `Hello, ${a.name}!` }];
  }
  if (name === 'echo') {
    if (typeof a.message !== 'string')
      throw new Error('echo: "message" (string) is required');
    const times = a.times === undefined || a.times === null ? 1 : Number(a.times);
    if (!Number.isInteger(times) || times < 0)
      throw new Error('echo: "times" must be a non-negative integer');
    return Array.from({ length: times }, (_, i) => ({ index: i, message: a.message }));
  }
  throw new Error(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Notifications (no id) — silently ignore
  if (msg.id === undefined || msg.id === null) return;

  const respond = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  const respondError = (code, message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n');

  try {
    switch (msg.method) {
      case 'initialize': {
        const params = msg.params || {};
        respond({
          protocolVersion: params.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
        });
        break;
      }
      case 'tools/list':
        respond({ tools: TOOLS });
        break;
      case 'tools/call': {
        const params = msg.params || {};
        const result = handleCall(params.name, params.arguments);
        respond({ content: [{ type: 'text', text: JSON.stringify(result) }] });
        break;
      }
      case 'ping':
        respond({});
        break;
      default:
        respondError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    respondError(-32603, err instanceof Error ? err.message : String(err));
  }
});

rl.on('close', () => process.exit(0));

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { executeWorkflow, mergeCallbacks } from './engine.js';
import { createTraceCallbacks, loadTrace, generateTraceSummary } from '../trace/trace.js';
import {
  createInteractHandler,
  AUTO_APPROVE_POLICY,
  AUTO_REJECT_POLICY,
} from './interact.js';
import { createAuthQueue } from './auth-retry.js';
import { getLocale, EN, ZH } from '../util/locale.js';
import type { ResolvedInteractSpec, WorkflowCallbacks } from '../schema/types.js';

cli({
  site: 'phase3-test',
  name: 'echo',
  description: 'echo adapter for phase3 tests',
  access: 'read',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'value', type: 'string' }],
  func: async (kwargs) => ({ value: kwargs.value }),
});

const writtenTraceFiles: string[] = [];

afterEach(() => {
  for (const f of writtenTraceFiles) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  writtenTraceFiles.length = 0;
});

// ── InteractProvider / Policy tests ────────────────────────────────────────

describe('InteractProvider and InteractPolicy', () => {
  it('AUTO_APPROVE_POLICY auto-approves confirms', () => {
    const spec: ResolvedInteractSpec = { type: 'confirm', message: 'Continue?' };
    expect(AUTO_APPROVE_POLICY.resolve('step', spec)).toBe(true);
  });

  it('AUTO_APPROVE_POLICY selects first option for select', () => {
    const spec: ResolvedInteractSpec = {
      type: 'select',
      message: 'Pick one',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    };
    expect(AUTO_APPROVE_POLICY.resolve('step', spec)).toBe('a');
  });

  it('AUTO_APPROVE_POLICY returns all values for multi-select', () => {
    const spec: ResolvedInteractSpec = {
      type: 'multi-select',
      message: 'Pick',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    };
    expect(AUTO_APPROVE_POLICY.resolve('step', spec)).toEqual(['a', 'b']);
  });

  it('AUTO_APPROVE_POLICY returns default for input', () => {
    const spec: ResolvedInteractSpec = { type: 'input', message: 'Enter', default: 'hello' };
    expect(AUTO_APPROVE_POLICY.resolve('step', spec)).toBe('hello');
  });

  it('AUTO_APPROVE_POLICY skips auth', () => {
    const spec: ResolvedInteractSpec = { type: 'auth', message: 'Login', site: 'test', timeout: 60 };
    expect(AUTO_APPROVE_POLICY.resolve('step', spec)).toBe('skip');
  });

  it('AUTO_REJECT_POLICY rejects confirms', () => {
    const spec: ResolvedInteractSpec = { type: 'confirm', message: 'Continue?' };
    expect(AUTO_REJECT_POLICY.resolve('step', spec)).toBe(false);
  });

  it('createInteractHandler uses policy first', async () => {
    let providerCalled = false;
    const provider = {
      prompt: async () => { providerCalled = true; return 'from-provider'; },
    };
    const handler = createInteractHandler(provider, AUTO_APPROVE_POLICY);

    const spec: ResolvedInteractSpec = { type: 'confirm', message: 'ok?' };
    const result = await handler('step', spec);
    expect(result).toBe(true);
    expect(providerCalled).toBe(false);
  });

  it('createInteractHandler falls through to provider when policy returns undefined', async () => {
    const policy = { resolve: () => undefined };
    const provider = {
      prompt: async () => 'from-provider',
    };
    const handler = createInteractHandler(provider, policy);

    const spec: ResolvedInteractSpec = { type: 'confirm', message: 'ok?' };
    const result = await handler('step', spec);
    expect(result).toBe('from-provider');
  });

  it('createInteractHandler auto-resolves when no provider and no policy match', async () => {
    const handler = createInteractHandler(null);
    const spec: ResolvedInteractSpec = { type: 'confirm', message: 'ok?' };
    const result = await handler('step', spec);
    expect(result).toBe(true);
  });
});

// ── Engine select fallback consistency ───────────────────────────────────

describe('engine select fallback returns single value (not array)', () => {
  it('select interact without onInteract returns first option value', async () => {
    const def = {
      name: 'select-fallback-test',
      steps: {
        'pick': {
          type: 'adapter' as const,
          interact: { type: 'select' as const, from: '$items', message: 'Pick one' },
        },
        'echo': {
          type: 'adapter' as const,
          adapter: 'phase3-test/echo',
          args: { value: '$pick' },
          depends_on: ['pick'],
        },
      },
    };

    const result = await executeWorkflow(def, { items: ['alpha', 'beta', 'gamma'] }, {});
    expect(result.status).toBe('completed');
    expect(result.context.pick).toBe('alpha');
  });

  it('multi-select interact without onInteract returns all options', async () => {
    const def = {
      name: 'multi-select-fallback-test',
      steps: {
        'pick': {
          type: 'adapter' as const,
          interact: { type: 'multi-select' as const, from: '$items', message: 'Pick many' },
        },
      },
    };

    const result = await executeWorkflow(def, { items: ['alpha', 'beta'] }, {});
    expect(result.status).toBe('completed');
    expect(result.context.pick).toEqual(['alpha', 'beta']);
  });
});

// ── Engine empty interact options guard ───────────────────────────────────

describe('engine empty interact options guard', () => {
  it('throws when select interact.from resolves to empty array', async () => {
    const def = {
      name: 'empty-select-test',
      steps: {
        'pick': {
          type: 'adapter' as const,
          interact: { type: 'select' as const, from: '$items', message: 'Pick one' },
        },
      },
    };

    const result = await executeWorkflow(def, { items: [] }, {});
    expect(result.status).toBe('failed');
  });

  it('throws when multi-select interact.from resolves to empty array', async () => {
    const def = {
      name: 'empty-multi-select-test',
      steps: {
        'pick': {
          type: 'adapter' as const,
          interact: { type: 'multi-select' as const, from: '$items', message: 'Pick many' },
        },
      },
    };

    const result = await executeWorkflow(def, { items: [] }, {});
    expect(result.status).toBe('failed');
  });
});

// ── Interact lifecycle events in trace ─────────────────────────────────────

describe('interact lifecycle events in trace', () => {
  it('records onInteractStart/End in trace for confirm gate', async () => {
    const trace = createTraceCallbacks();
    const interactHandler: WorkflowCallbacks = {
      onInteract: async (_stepName, spec) => {
        if (spec.type === 'confirm') return true;
        return undefined;
      },
    };

    const def = {
      name: 'interact-lifecycle-test',
      steps: {
        's1': {
          type: 'adapter' as const,
          adapter: 'phase3-test/echo',
          args: { value: 'hi' },
          confirm: true,
        },
      },
    };

    const result = await executeWorkflow(def, {}, {
      callbacks: mergeCallbacks(interactHandler, trace.callbacks),
    });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    expect(loaded).toBeTruthy();
    const s1Record = loaded.steps.find(s => s.name === 's1')!;
    expect(s1Record.interacts).toBeDefined();
    expect(s1Record.interacts!.length).toBeGreaterThan(0);
    expect(s1Record.interacts![0].type).toBe('confirm');
    expect(s1Record.interacts![0].durationMs).toBeGreaterThanOrEqual(0);
    expect(s1Record.interacts![0].result).toBe(true);
  });

  it('records interact events for select interaction', async () => {
    const trace = createTraceCallbacks();
    const interactHandler: WorkflowCallbacks = {
      onInteract: async (_stepName, spec) => {
        if (spec.type === 'select' && 'options' in spec) {
          return spec.options[0].value;
        }
        return undefined;
      },
    };

    const def = {
      name: 'interact-select-trace-test',
      steps: {
        'pick': {
          type: 'adapter' as const,
          interact: { type: 'select' as const, from: '$items', message: 'Pick one' },
        },
      },
    };

    const result = await executeWorkflow(def, { items: [{ name: 'A' }, { name: 'B' }] }, {
      callbacks: mergeCallbacks(interactHandler, trace.callbacks),
    });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const pickRecord = loaded.steps.find(s => s.name === 'pick')!;
    expect(pickRecord.interacts).toBeDefined();
    expect(pickRecord.interacts![0].type).toBe('select');
    expect(pickRecord.interacts![0].message).toBe('Pick one');
  });

  it('generateTraceSummary includes interact details', async () => {
    const trace = createTraceCallbacks();
    const interactHandler: WorkflowCallbacks = {
      onInteract: async (_stepName, spec) => {
        if (spec.type === 'confirm') return true;
        return undefined;
      },
    };

    const def = {
      name: 'summary-interact-test',
      steps: {
        's1': {
          type: 'adapter' as const,
          adapter: 'phase3-test/echo',
          args: { value: 'hi' },
          confirm: 'Proceed?',
        },
      },
    };

    const result = await executeWorkflow(def, {}, {
      callbacks: mergeCallbacks(interactHandler, trace.callbacks),
    });
    const filePath = trace.finalize(result.status, result.finishedAt);
    if (filePath) writtenTraceFiles.push(filePath);

    const loaded = loadTrace(result.id)!;
    const summary = generateTraceSummary(loaded);
    expect(summary).toContain('Interact:');
    expect(summary).toContain('confirm');
  });
});

// ── AuthQueue encapsulation ────────────────────────────────────────────────

describe('AuthQueue encapsulation', () => {
  it('enqueues tasks sequentially', async () => {
    const queue = createAuthQueue();
    const order: number[] = [];

    await Promise.all([
      queue.enqueue(async () => {
        await new Promise(r => setTimeout(r, 10));
        order.push(1);
        return 1;
      }),
      queue.enqueue(async () => {
        order.push(2);
        return 2;
      }),
    ]);

    expect(order).toEqual([1, 2]);
  });

  it('independent queues do not interfere', async () => {
    const q1 = createAuthQueue();
    const q2 = createAuthQueue();
    const order: string[] = [];

    const p1 = q1.enqueue(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push('q1');
    });
    const p2 = q2.enqueue(async () => {
      order.push('q2');
    });

    await Promise.all([p1, p2]);
    expect(order[0]).toBe('q2');
    expect(order[1]).toBe('q1');
  });
});

// ── Locale tests ───────────────────────────────────────────────────────────

describe('locale', () => {
  const origLocale = process.env.OPENCLI_LOCALE;
  const origLang = process.env.LANG;

  afterEach(() => {
    if (origLocale !== undefined) process.env.OPENCLI_LOCALE = origLocale;
    else delete process.env.OPENCLI_LOCALE;
    if (origLang !== undefined) process.env.LANG = origLang;
    else delete process.env.LANG;
  });

  it('returns EN locale by default', () => {
    delete process.env.OPENCLI_LOCALE;
    process.env.LANG = 'en_US.UTF-8';
    const locale = getLocale();
    expect(locale.confirm_yes).toBe('Yes');
    expect(locale.confirm_no).toBe('No');
  });

  it('returns ZH locale when OPENCLI_LOCALE=zh', () => {
    process.env.OPENCLI_LOCALE = 'zh_CN';
    const locale = getLocale();
    expect(locale.confirm_yes).toBe('确认');
    expect(locale.confirm_no).toBe('取消');
  });

  it('EN and ZH have all the same keys', () => {
    const enKeys = Object.keys(EN).sort();
    const zhKeys = Object.keys(ZH).sort();
    expect(enKeys).toEqual(zhKeys);
  });
});

// ── mergeCallbacks fan-out for interact lifecycle ──────────────────────────

describe('mergeCallbacks interact lifecycle fan-out', () => {
  it('fans out onInteractStart and onInteractEnd to all callbacks', async () => {
    const events1: string[] = [];
    const events2: string[] = [];

    const cb1: WorkflowCallbacks = {
      onInteractStart: () => events1.push('start'),
      onInteractEnd: () => events1.push('end'),
      onInteract: async () => true,
    };
    const cb2: WorkflowCallbacks = {
      onInteractStart: () => events2.push('start'),
      onInteractEnd: () => events2.push('end'),
    };

    const merged = mergeCallbacks(cb1, cb2);

    const def = {
      name: 'merge-interact-test',
      steps: {
        's1': {
          type: 'adapter' as const,
          adapter: 'phase3-test/echo',
          args: { value: 'hi' },
          confirm: true,
        },
      },
    };

    await executeWorkflow(def, {}, { callbacks: merged });

    expect(events1).toContain('start');
    expect(events1).toContain('end');
    expect(events2).toContain('start');
    expect(events2).toContain('end');
  });
});

// ── tui-renderer.ts deletion verification ──────────────────────────────────

describe('ANSI TUI renderer deleted', () => {
  it('tui-renderer.ts file does not exist', () => {
    const tuiPath = path.join(__dirname, 'tui-renderer.ts');
    expect(fs.existsSync(tuiPath)).toBe(false);
  });
});

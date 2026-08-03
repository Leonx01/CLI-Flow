import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliflow-memory-test-'));
  process.env.CLIFLOW_MEMORY_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CLIFLOW_MEMORY_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function freshImport() {
  const mod = await import(`./memory.js?t=${Date.now()}`);
  return mod;
}

describe('memory', () => {
  // Notes needs a fresh import each time because MEMORY_DIR is set at module load.
  // Since the env var is read at module scope, we re-import or call functions directly.
  // Actually MEMORY_BASE uses process.env at module-load time. Let's just use dynamic imports.

  describe('notes', () => {
    it('addNote creates notes.md with date header', async () => {
      const { addNote, loadNotes, hasNotes } = await import('./memory.js');
      addNote('test-wf', 'first note', 'abc123');
      expect(hasNotes('test-wf')).toBe(true);

      const notes = loadNotes('test-wf');
      expect(notes).toHaveLength(1);
      expect(notes[0].text).toBe('first note');
      expect(notes[0].hash).toBe('abc123');
    });

    it('prepends new notes at top', async () => {
      const { addNote, loadNotes } = await import('./memory.js');
      addNote('test-wf', 'first', 'aaa');
      addNote('test-wf', 'second', 'bbb');

      const notes = loadNotes('test-wf');
      expect(notes).toHaveLength(2);
      expect(notes[0].text).toBe('second');
      expect(notes[1].text).toBe('first');
    });

    it('marks stale when hash differs', async () => {
      const { addNote, loadNotes } = await import('./memory.js');
      addNote('test-wf', 'old note', 'aaa111');
      addNote('test-wf', 'new note', 'bbb222');

      const notes = loadNotes('test-wf', 'bbb222');
      expect(notes[0].stale).toBe(false);
      expect(notes[1].stale).toBe(true);
    });

    it('note without hash is never stale', async () => {
      const { addNote, loadNotes } = await import('./memory.js');
      addNote('test-wf', 'no hash note');

      const notes = loadNotes('test-wf', 'somehash');
      expect(notes[0].stale).toBe(false);
      expect(notes[0].hash).toBe('');
    });

    it('returns empty array for nonexistent workflow', async () => {
      const { loadNotes, hasNotes } = await import('./memory.js');
      expect(loadNotes('nonexistent')).toEqual([]);
      expect(hasNotes('nonexistent')).toBe(false);
    });
  });

  describe('adapter memory', () => {
    it('creates adapter file with header', async () => {
      const { addAdapterNote, loadAdapterMemory, hasAdapterMemory } = await import('./memory.js');
      addAdapterNote('dashscope', 'concurrency > 3 triggers rate limit');

      expect(hasAdapterMemory('dashscope')).toBe(true);
      const content = loadAdapterMemory('dashscope');
      expect(content).toContain('# dashscope');
      expect(content).toContain('- concurrency > 3 triggers rate limit');
    });

    it('appends to existing adapter file', async () => {
      const { addAdapterNote, loadAdapterMemory } = await import('./memory.js');
      addAdapterNote('zhihu', 'auth expires in 24h');
      addAdapterNote('zhihu', 'rate limit is 60 req/min');

      const content = loadAdapterMemory('zhihu')!;
      expect(content).toContain('- auth expires in 24h');
      expect(content).toContain('- rate limit is 60 req/min');
    });

    it('returns null for nonexistent adapter', async () => {
      const { loadAdapterMemory, hasAdapterMemory } = await import('./memory.js');
      expect(loadAdapterMemory('nonexistent')).toBeNull();
      expect(hasAdapterMemory('nonexistent')).toBe(false);
    });

    it('lists all adapters', async () => {
      const { addAdapterNote, listAdapters } = await import('./memory.js');
      addAdapterNote('dashscope', 'note1');
      addAdapterNote('zhihu', 'note2');

      const adapters = listAdapters();
      expect(adapters).toContain('dashscope');
      expect(adapters).toContain('zhihu');
    });
  });

  describe('insights', () => {
    it('creates insights on first run', async () => {
      const { updateInsights, loadInsights } = await import('./memory.js');
      updateInsights('test-wf', {
        id: 'cfrun_1', workflow: 'test-wf', status: 'completed',
        completedSteps: ['a', 'b'], failedSteps: [], skippedSteps: [],
        context: {}, startedAt: 1000, finishedAt: 11000,
        stepRecords: [
          { name: 'a', status: 'completed' },
          { name: 'b', status: 'completed' },
        ],
      });

      const insights = loadInsights('test-wf');
      expect(insights).not.toBeNull();
      expect(insights!.total_runs).toBe(1);
      expect(insights!.successes).toBe(1);
      expect(insights!.failures).toBe(0);
      expect(insights!.avg_duration_seconds).toBe(10);
      expect(insights!.recent_failures).toEqual([]);
    });

    it('accumulates stats across runs', async () => {
      const { updateInsights, loadInsights } = await import('./memory.js');
      const base = {
        workflow: 'test-wf', completedSteps: [], failedSteps: [],
        skippedSteps: [], context: {}, stepRecords: [],
      };

      updateInsights('test-wf', { ...base, id: 'r1', status: 'completed', startedAt: 0, finishedAt: 10000 });
      updateInsights('test-wf', { ...base, id: 'r2', status: 'completed', startedAt: 0, finishedAt: 20000 });

      const insights = loadInsights('test-wf')!;
      expect(insights.total_runs).toBe(2);
      expect(insights.successes).toBe(2);
      expect(insights.avg_duration_seconds).toBe(15);
    });

    it('records recent failures with step details', async () => {
      const { updateInsights, loadInsights } = await import('./memory.js');
      updateInsights('test-wf', {
        id: 'cfrun_fail', workflow: 'test-wf', status: 'failed',
        completedSteps: [], failedSteps: ['fetch'], skippedSteps: [],
        context: {}, startedAt: 0, finishedAt: 5000,
        stepRecords: [
          { name: 'fetch', status: 'failed', error: 'AuthRequiredError' },
        ],
      });

      const insights = loadInsights('test-wf')!;
      expect(insights.failures).toBe(1);
      expect(insights.recent_failures).toHaveLength(1);
      expect(insights.recent_failures[0].step).toBe('fetch');
      expect(insights.recent_failures[0].error).toBe('AuthRequiredError');
    });

    it('truncates recent_failures at 10', async () => {
      const { updateInsights, loadInsights } = await import('./memory.js');
      for (let i = 0; i < 12; i++) {
        updateInsights('test-wf', {
          id: `cfrun_${i}`, workflow: 'test-wf', status: 'failed',
          completedSteps: [], failedSteps: ['step'], skippedSteps: [],
          context: {}, startedAt: 0, finishedAt: 1000,
          stepRecords: [{ name: 'step', status: 'failed', error: `err${i}` }],
        });
      }

      const insights = loadInsights('test-wf')!;
      expect(insights.recent_failures).toHaveLength(10);
      expect(insights.recent_failures[0].error).toBe('err11');
    });

    it('returns null for nonexistent', async () => {
      const { loadInsights } = await import('./memory.js');
      expect(loadInsights('nonexistent')).toBeNull();
    });
  });

  describe('snapshots', () => {
    it('saves YAML and lists with step summary', async () => {
      const { saveSnapshot, listSnapshots } = await import('./memory.js');
      const yamlContent = 'name: test\nsteps:\n  fetch:\n    adapter: hn/top\n  save:\n    adapter: local/save\n';
      const yamlPath = path.join(tmpDir, 'test.yaml');
      fs.writeFileSync(yamlPath, yamlContent);

      saveSnapshot('test-wf', yamlPath, 'abc123');

      const snapshots = listSnapshots('test-wf');
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].hash).toBe('abc123');
      expect(snapshots[0].steps).toContain('fetch');
      expect(snapshots[0].steps).toContain('save');
    });

    it('skips duplicate hash', async () => {
      const { saveSnapshot, listSnapshots } = await import('./memory.js');
      const yamlPath = path.join(tmpDir, 'test.yaml');
      fs.writeFileSync(yamlPath, 'name: test\nsteps:\n  a:\n    adapter: x/y\n');

      saveSnapshot('test-wf', yamlPath, 'same');
      saveSnapshot('test-wf', yamlPath, 'same');

      expect(listSnapshots('test-wf')).toHaveLength(1);
    });

    it('returns empty for nonexistent', async () => {
      const { listSnapshots } = await import('./memory.js');
      expect(listSnapshots('nonexistent')).toEqual([]);
    });
  });

  describe('diff', () => {
    it('diffs two snapshots', async () => {
      const { saveSnapshot, diffSnapshots } = await import('./memory.js');
      const yaml1 = path.join(tmpDir, 'v1.yaml');
      const yaml2 = path.join(tmpDir, 'v2.yaml');
      fs.writeFileSync(yaml1, 'name: test\ntimeout: 30\n');
      fs.writeFileSync(yaml2, 'name: test\ntimeout: 60\n');

      saveSnapshot('test-wf', yaml1, 'hash1');
      saveSnapshot('test-wf', yaml2, 'hash2');

      const diff = diffSnapshots('test-wf', 'hash1', 'hash2');
      expect(diff).toContain('- timeout: 30');
      expect(diff).toContain('+ timeout: 60');
    });

    it('returns null for missing snapshot', async () => {
      const { diffSnapshots } = await import('./memory.js');
      expect(diffSnapshots('test-wf', 'missing1', 'missing2')).toBeNull();
    });
  });

  describe('aggregate', () => {
    it('loadMemory returns full report', async () => {
      const { addNote, updateInsights, loadMemory } = await import('./memory.js');
      addNote('test-wf', 'a note', 'abc');
      updateInsights('test-wf', {
        id: 'r1', workflow: 'test-wf', status: 'completed',
        completedSteps: ['a'], failedSteps: [], skippedSteps: [],
        context: {}, startedAt: 0, finishedAt: 5000, stepRecords: [],
      });

      const report = loadMemory('test-wf', 'abc');
      expect(report.notes).toHaveLength(1);
      expect(report.insights).not.toBeNull();
      expect(report.insights!.total_runs).toBe(1);
    });

    it('deleteMemory removes directory', async () => {
      const { addNote, deleteMemory, hasNotes } = await import('./memory.js');
      addNote('test-wf', 'temp note');
      expect(hasNotes('test-wf')).toBe(true);

      const deleted = deleteMemory('test-wf');
      expect(deleted).toBe(true);
      expect(hasNotes('test-wf')).toBe(false);
    });

    it('deleteMemory returns false for nonexistent', async () => {
      const { deleteMemory } = await import('./memory.js');
      expect(deleteMemory('nonexistent')).toBe(false);
    });

    it('listMemories shows all workflows', async () => {
      const { addNote, listMemories } = await import('./memory.js');
      addNote('wf-a', 'note a');
      addNote('wf-b', 'note b');

      const list = listMemories();
      expect(list).toHaveLength(2);
      expect(list.map(l => l.workflow)).toContain('wf-a');
      expect(list.map(l => l.workflow)).toContain('wf-b');
    });
  });

  describe('getMemoryHint', () => {
    const baseDef = { name: 'test-wf', steps: { fetch: { adapter: 'zhihu/search' } } };
    const baseResult = {
      id: 'cfrun_x', workflow: 'test-wf',
      completedSteps: [], failedSteps: [], skippedSteps: [],
      context: {}, startedAt: 0, finishedAt: 1000,
    };

    it('failed + has workflow notes -> points to workflow memory', async () => {
      const { addNote, getMemoryHint } = await import('./memory.js');
      addNote('test-wf', 'known issue');

      const hint = getMemoryHint('test-wf', {
        ...baseResult, status: 'failed',
        stepRecords: [{ name: 'fetch', status: 'failed', error: 'AuthRequiredError' }],
      } as any, baseDef as any, 'wf.yaml');

      expect(hint).toBe(`hint: run \`cliflow memory test-wf\` to check related notes`);
    });

    it('failed + no workflow notes but adapter has memory -> points to adapter', async () => {
      const { addAdapterNote, getMemoryHint } = await import('./memory.js');
      addAdapterNote('zhihu', 'auth expires in 24h');

      const hint = getMemoryHint('test-wf', {
        ...baseResult, status: 'failed',
        stepRecords: [{ name: 'fetch', status: 'failed', error: 'AuthRequiredError' }],
      } as any, baseDef as any, 'wf.yaml');

      expect(hint).toBe(`hint: run \`cliflow memory adapter zhihu\` to check known issues`);
    });

    it('failed + no memory at all -> suggests adding a note', async () => {
      const { getMemoryHint } = await import('./memory.js');

      const hint = getMemoryHint('test-wf', {
        ...baseResult, status: 'failed',
        stepRecords: [{ name: 'fetch', status: 'failed', error: 'X' }],
      } as any, baseDef as any, 'wf.yaml');

      expect(hint).toContain('cliflow memory test-wf add');
      expect(hint).toContain('wf.yaml');
    });

    it('success + first run (no insights) -> suggests adding a note', async () => {
      const { getMemoryHint } = await import('./memory.js');

      const hint = getMemoryHint('test-wf', {
        ...baseResult, status: 'completed', stepRecords: [],
      } as any, baseDef as any, 'wf.yaml');

      expect(hint).toContain('cliflow memory test-wf add');
    });

    it('success + stable insights + no stale notes -> no hint', async () => {
      const { updateInsights, getMemoryHint } = await import('./memory.js');
      updateInsights('test-wf', {
        ...baseResult, status: 'completed', stepRecords: [],
      } as any);

      const hint = getMemoryHint('test-wf', {
        ...baseResult, status: 'completed', stepRecords: [],
      } as any, baseDef as any, 'wf.yaml');

      expect(hint).toBeNull();
    });

    it('success + stale notes -> suggests reviewing', async () => {
      const { addNote, updateInsights, getMemoryHint } = await import('./memory.js');
      addNote('test-wf', 'old finding', 'deadbeef');
      updateInsights('test-wf', {
        ...baseResult, status: 'completed', stepRecords: [],
      } as any);

      // hashDefinition of baseDef will differ from 'deadbeef', making the note stale.
      const hint = getMemoryHint('test-wf', {
        ...baseResult, status: 'completed', stepRecords: [],
      } as any, baseDef as any, 'wf.yaml');

      expect(hint).toBe(`hint: run \`cliflow memory test-wf\` to review stale notes`);
    });
  });
});

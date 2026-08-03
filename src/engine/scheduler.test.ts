import { describe, it, expect } from 'vitest';
import { DAGScheduler, CycleError } from './scheduler.js';
import type { WorkflowStep } from '../schema/types.js';

function makeSteps(steps: Record<string, Partial<WorkflowStep>>): Record<string, WorkflowStep> {
  const result: Record<string, WorkflowStep> = {};
  for (const [name, step] of Object.entries(steps)) {
    result[name] = { type: 'adapter', adapter: 'test/noop', ...step };
  }
  return result;
}

describe('DAGScheduler', () => {
  describe('validate', () => {
    it('accepts a valid DAG with no cycles', () => {
      const steps = makeSteps({
        a: {},
        b: { depends_on: ['a'] },
        c: { depends_on: ['a'] },
        d: { depends_on: ['b', 'c'] },
      });
      const scheduler = new DAGScheduler(steps);
      expect(scheduler.validate()).toEqual({ valid: true });
    });

    it('accepts steps with no dependencies', () => {
      const steps = makeSteps({ a: {}, b: {}, c: {} });
      const scheduler = new DAGScheduler(steps);
      expect(scheduler.validate()).toEqual({ valid: true });
    });

    it('detects a simple cycle', () => {
      const steps = makeSteps({
        a: { depends_on: ['b'] },
        b: { depends_on: ['a'] },
      });
      const scheduler = new DAGScheduler(steps);
      const result = scheduler.validate();
      expect(result.valid).toBe(false);
      expect(result.cycle).toBeDefined();
      expect(result.cycle!.length).toBeGreaterThan(1);
    });

    it('detects a 3-node cycle', () => {
      const steps = makeSteps({
        a: { depends_on: ['c'] },
        b: { depends_on: ['a'] },
        c: { depends_on: ['b'] },
      });
      const scheduler = new DAGScheduler(steps);
      expect(scheduler.validate().valid).toBe(false);
    });
  });

  describe('getReady', () => {
    it('returns all root nodes when nothing is completed', () => {
      const steps = makeSteps({
        a: {},
        b: {},
        c: { depends_on: ['a'] },
      });
      const scheduler = new DAGScheduler(steps);
      const ready = scheduler.getReady(new Set());
      expect(ready).toContain('a');
      expect(ready).toContain('b');
      expect(ready).not.toContain('c');
    });

    it('unblocks dependents when dependencies complete', () => {
      const steps = makeSteps({
        a: {},
        b: { depends_on: ['a'] },
        c: { depends_on: ['a', 'b'] },
      });
      const scheduler = new DAGScheduler(steps);

      let ready = scheduler.getReady(new Set());
      expect(ready).toEqual(['a']);

      ready = scheduler.getReady(new Set(['a']));
      expect(ready).toEqual(['b']);

      ready = scheduler.getReady(new Set(['a', 'b']));
      expect(ready).toEqual(['c']);
    });

    it('returns parallel steps when both are ready', () => {
      const steps = makeSteps({
        fetch: {},
        'pub-xhs': { depends_on: ['fetch'] },
        'pub-douyin': { depends_on: ['fetch'] },
        report: { depends_on: ['pub-xhs', 'pub-douyin'] },
      });
      const scheduler = new DAGScheduler(steps);

      const ready = scheduler.getReady(new Set(['fetch']));
      expect(ready).toContain('pub-xhs');
      expect(ready).toContain('pub-douyin');
      expect(ready).not.toContain('report');
    });

    it('fan-in waits for all dependencies', () => {
      const steps = makeSteps({
        a: {},
        b: {},
        merge: { depends_on: ['a', 'b'] },
      });
      const scheduler = new DAGScheduler(steps);

      expect(scheduler.getReady(new Set(['a']))).not.toContain('merge');
      expect(scheduler.getReady(new Set(['a', 'b']))).toContain('merge');
    });

    it('returns empty when all completed', () => {
      const steps = makeSteps({ a: {}, b: { depends_on: ['a'] } });
      const scheduler = new DAGScheduler(steps);
      expect(scheduler.getReady(new Set(['a', 'b']))).toEqual([]);
    });
  });

  describe('plan', () => {
    it('produces correct execution waves', () => {
      const steps = makeSteps({
        fetch: {},
        enrich: { depends_on: ['fetch'] },
        'pub-a': { depends_on: ['enrich'] },
        'pub-b': { depends_on: ['enrich'] },
        report: { depends_on: ['pub-a', 'pub-b'] },
      });
      const scheduler = new DAGScheduler(steps);
      const waves = scheduler.plan();

      expect(waves.length).toBe(4);
      expect(waves[0].parallel).toEqual(['fetch']);
      expect(waves[1].parallel).toEqual(['enrich']);
      expect(waves[2].parallel).toContain('pub-a');
      expect(waves[2].parallel).toContain('pub-b');
      expect(waves[3].parallel).toEqual(['report']);
    });

    it('all independent steps in one wave', () => {
      const steps = makeSteps({ a: {}, b: {}, c: {}, d: {} });
      const scheduler = new DAGScheduler(steps);
      const waves = scheduler.plan();
      expect(waves.length).toBe(1);
      expect(waves[0].parallel.length).toBe(4);
    });
  });
});

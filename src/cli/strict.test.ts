import { describe, expect, it } from 'vitest';
import { computeCoverage, evaluateStrict } from './strict.js';
import type { WorkflowRunResult, WorkflowDefinition, StepRecord } from '../schema/types.js';

function rec(name: string, status: StepRecord['status'], extra: Partial<StepRecord> = {}): StepRecord {
  return { name, status, ...extra };
}

function result(over: Partial<WorkflowRunResult> = {}): WorkflowRunResult {
  return {
    id: 'r1', workflow: 'w', status: 'completed',
    completedSteps: [], failedSteps: [], skippedSteps: [],
    context: {}, startedAt: 0, finishedAt: 1, stepRecords: [],
    ...over,
  };
}

const def = (outputs?: string[]): WorkflowDefinition => ({ name: 'w', steps: {}, outputs });

describe('computeCoverage', () => {
  it('counts executed excluding skipped, and lists skipped / foreachFailed / emptyOutputs', () => {
    const r = result({
      skippedSteps: ['s2'],
      stepRecords: [
        rec('s1', 'completed'),
        rec('s2', 'skipped'),
        rec('s3', 'completed', { foreachErrors: ['item 0: boom'] }),
      ],
      context: { out_a: [1], out_b: [] },
    });
    const cov = computeCoverage(r, def(['out_a', 'out_b', 'out_c']));
    expect(cov.executed).toBe(2);              // s1 + s3 (s2 skipped)
    expect(cov.skipped).toEqual(['s2']);
    expect(cov.foreachFailed).toEqual(['s3']);
    expect(cov.emptyOutputs.sort()).toEqual(['out_b', 'out_c']); // [] and missing both empty
  });
});

describe('evaluateStrict', () => {
  it('flags a skipped step not in allowSkip', () => {
    const r = result({ skippedSteps: ['save'], stepRecords: [rec('save', 'skipped')] });
    expect(evaluateStrict(r, def(), [])).toEqual([
      'step "save" was skipped (not in --allow-skip)',
    ]);
  });

  it('allows a skipped step listed in allowSkip', () => {
    const r = result({ skippedSteps: ['save'], stepRecords: [rec('save', 'skipped')] });
    expect(evaluateStrict(r, def(), ['save'])).toEqual([]);
  });

  it('flags foreach item failures', () => {
    const r = result({ stepRecords: [rec('pub', 'completed', { foreachErrors: ['item 0: content required'] })] });
    const v = evaluateStrict(r, def(), []);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('foreach item failure');
  });

  it('flags empty declared outputs', () => {
    const r = result({ context: { report: [] } });
    expect(evaluateStrict(r, def(['report']), [])).toEqual([
      'declared output "report" is empty',
    ]);
  });

  it('passes (no violations) on a clean run', () => {
    const r = result({ stepRecords: [rec('a', 'completed')], context: { out: [1] } });
    expect(evaluateStrict(r, def(['out']), [])).toEqual([]);
  });
});

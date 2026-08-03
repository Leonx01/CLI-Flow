import { describe, expect, it } from 'vitest';
import { validateWorkflow } from './validator.js';
import type { WorkflowDefinition } from './types.js';

/** Minimal helper to build a WorkflowDefinition for validator tests. */
function def(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { name: 'test', steps };
}

describe('validateWorkflow flatten:false mismatch rule', () => {
  it('warns when a foreach consumes a flatten:false producer via $item.<field>', () => {
    const warnings = validateWorkflow(def({
      produce: { adapter: 'x/y', flatten: false, output: 'groups' },
      consume: { adapter: 'a/b', foreach: '$groups', args: { q: '$item.title' }, depends_on: ['produce'] },
    }));
    const w = warnings.find(x => x.step === 'consume' && x.field === 'foreach');
    expect(w).toBeTruthy();
    expect(w!.message).toContain('flatten:false');
    expect(w!.message).toContain('.flat()');
  });

  it('does NOT warn when the foreach is already flattened with .flat()', () => {
    const warnings = validateWorkflow(def({
      produce: { adapter: 'x/y', flatten: false, output: 'groups' },
      consume: { adapter: 'a/b', foreach: '${{ args.groups.flat() }}', args: { q: '$item.title' }, depends_on: ['produce'] },
    }));
    expect(warnings.some(x => x.step === 'consume' && x.field === 'foreach')).toBe(false);
  });

  it('does NOT warn when $item is forwarded whole (no dotted field access)', () => {
    // legitimate flatten:false use: passing each inner array as one nested-workflow input
    const warnings = validateWorkflow(def({
      produce: { adapter: 'x/y', flatten: false, output: 'groups' },
      consume: { type: 'workflow', workflow: './sub.yaml', foreach: '$groups', args: { notes: '$item' }, depends_on: ['produce'] },
    }));
    expect(warnings.some(x => x.step === 'consume' && x.field === 'foreach')).toBe(false);
  });

  it('does NOT warn when the producer is a normal (flattened) step', () => {
    const warnings = validateWorkflow(def({
      produce: { adapter: 'x/y', output: 'groups' },
      consume: { adapter: 'a/b', foreach: '$groups', args: { q: '$item.title' }, depends_on: ['produce'] },
    }));
    expect(warnings.some(x => x.step === 'consume' && x.field === 'foreach')).toBe(false);
  });
});

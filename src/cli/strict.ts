/**
 * Strict-mode evaluation for `cliflow run --strict`.
 *
 * Extracted from cli/index.ts as pure functions so the guardrail itself is
 * unit-testable. The engine counts skipped steps into completedSteps and a
 * foreach that fails every item still ends a step "completed" — so a plain
 * status check hides these silent failures. computeCoverage() exposes the
 * honest view; evaluateStrict() turns the failure modes into violation
 * strings that the CLI escalates to a non-zero exit.
 */

import type { WorkflowRunResult, WorkflowDefinition } from '../schema/types.js';

export interface Coverage {
  /** Steps that truly executed (completed and not skipped). */
  executed: number;
  /** Step names that were skipped (condition false / on_error skip / dependency). */
  skipped: string[];
  /** Step names that had at least one foreach item failure. */
  foreachFailed: string[];
  /** Declared workflow outputs that resolved to null/undefined/[]. */
  emptyOutputs: string[];
}

export function computeCoverage(
  result: WorkflowRunResult,
  definition: WorkflowDefinition,
): Coverage {
  const skippedSet = new Set(result.skippedSteps);
  return {
    executed: result.stepRecords.filter(r => r.status === 'completed' && !skippedSet.has(r.name)).length,
    skipped: [...result.skippedSteps],
    foreachFailed: result.stepRecords.filter(r => (r.foreachErrors?.length ?? 0) > 0).map(r => r.name),
    emptyOutputs: (definition.outputs ?? []).filter(k => {
      const v = (result.context as Record<string, unknown>)[k];
      return v == null || (Array.isArray(v) && v.length === 0);
    }),
  };
}

/**
 * Return the list of strict-mode violations (empty = passes).
 * `allowSkip` lists step names permitted to be skipped without a violation.
 */
export function evaluateStrict(
  result: WorkflowRunResult,
  definition: WorkflowDefinition,
  allowSkip: string[] = [],
): string[] {
  const coverage = computeCoverage(result, definition);
  const allow = new Set(allowSkip.map(s => s.trim()).filter(Boolean));
  const violations: string[] = [];

  for (const name of coverage.skipped) {
    if (!allow.has(name)) violations.push(`step "${name}" was skipped (not in --allow-skip)`);
  }
  for (const rec of result.stepRecords) {
    if (rec.foreachErrors?.length) {
      violations.push(`step "${rec.name}" had ${rec.foreachErrors.length} foreach item failure(s): ${rec.foreachErrors[0]}`);
    }
  }
  for (const key of coverage.emptyOutputs) {
    violations.push(`declared output "${key}" is empty`);
  }
  return violations;
}

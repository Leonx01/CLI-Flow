/**
 * Static variable reference validation for workflow definitions.
 *
 * Checks that every $variable reference in step args, foreach, and condition
 * refers to a known output and that the producing step is reachable via the
 * depends_on chain.
 */

import type { WorkflowDefinition, StepOutput } from './types.js';

export interface ValidationWarning {
  step: string;
  field: string;
  reference: string;
  message: string;
}

/** Regex matching a dollar-sign variable reference: $varName (no dashes) */
const VAR_REF_RE = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Regex matching ${{ args.xxx }} template references */
const TEMPLATE_REF_RE = /\$\{\{\s*args\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Foreach-local variables that should not be validated as step outputs. */
const FOREACH_LOCALS = new Set(['item', 'index']);

/**
 * Recursively extract all string values from a value tree (args object,
 * nested objects/arrays).  Returns tuples of (dotPath, stringValue).
 */
function extractStrings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === 'string') {
    return [[path, value]];
  }
  if (Array.isArray(value)) {
    const results: Array<[string, string]> = [];
    for (let i = 0; i < value.length; i++) {
      results.push(...extractStrings(value[i], `${path}[${i}]`));
    }
    return results;
  }
  if (value !== null && typeof value === 'object') {
    const results: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      results.push(...extractStrings(v, path ? `${path}.${k}` : k));
    }
    return results;
  }
  return [];
}

/**
 * Build the transitive dependency set for a step using BFS over depends_on.
 */
function transitiveDeps(
  stepName: string,
  steps: Record<string, { depends_on?: string[] }>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [...(steps[stepName]?.depends_on ?? [])];
  while (queue.length > 0) {
    const dep = queue.shift()!;
    if (visited.has(dep)) continue;
    visited.add(dep);
    for (const next of steps[dep]?.depends_on ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

/** Regex matching $varname-suffix where varname-suffix is an existing step name with dashes */
const DASHED_REF_RE = /\$([a-zA-Z_]\w*)-(\w[\w-]*)/g;

/**
 * Validate variable references in a workflow definition.
 *
 * 1. Every $variable reference must correspond to a step output.
 * 2. The producing step must be reachable via the referencing step's
 *    depends_on chain (direct or transitive).
 * 3. Dashed step name references ($step-name) are flagged — variable
 *    names cannot contain dashes; use the underscored form instead.
 */
export function validateWorkflow(definition: WorkflowDefinition): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const steps = definition.steps;

  // Build outputs map: output variable name -> producing step name
  const outputToStep = new Map<string, string>();

  // Register workflow inputs as known variables
  if (definition.inputs) {
    for (const name of Object.keys(definition.inputs)) {
      outputToStep.set(name, '__input__');
    }
  }

  for (const [stepName, step] of Object.entries(steps)) {
    let outputVar: string;
    if (step.output === undefined) {
      outputVar = stepName.replace(/-/g, '_');
    } else if (typeof step.output === 'string') {
      outputVar = step.output;
    } else {
      outputVar = (step.output as StepOutput).as ?? stepName.replace(/-/g, '_');
    }

    const existingProducer = outputToStep.get(outputVar);
    if (existingProducer && existingProducer !== '__input__' && existingProducer !== stepName) {
      warnings.push({
        step: stepName,
        field: 'output',
        reference: `$${outputVar}`,
        message: `output variable "$${outputVar}" collides with step "${existingProducer}" — the later step's output will overwrite the earlier one`,
      });
    }

    outputToStep.set(outputVar, stepName);
  }

  // Cache transitive deps per step
  const depsCache = new Map<string, Set<string>>();
  const getTransitiveDeps = (stepName: string): Set<string> => {
    let cached = depsCache.get(stepName);
    if (!cached) {
      cached = transitiveDeps(stepName, steps);
      depsCache.set(stepName, cached);
    }
    return cached;
  };

  for (const [stepName, step] of Object.entries(steps)) {
    // Collect all (field, stringValue) pairs to scan
    const fieldsToScan: Array<[string, string]> = [];

    // step.args (recursively)
    if (step.args) {
      for (const [fieldPath, str] of extractStrings(step.args, 'args')) {
        fieldsToScan.push([fieldPath, str]);
      }
    }

    // step.foreach
    if (step.foreach) {
      fieldsToScan.push(['foreach', step.foreach]);
    }

    // step.condition
    if (step.condition) {
      fieldsToScan.push(['condition', step.condition]);
    }

    // Scan each string for $variable references
    for (const [field, value] of fieldsToScan) {
      // Scan $varname syntax
      let match: RegExpExecArray | null;
      VAR_REF_RE.lastIndex = 0;
      while ((match = VAR_REF_RE.exec(value)) !== null) {
        const varName = match[1];
        if (FOREACH_LOCALS.has(varName)) continue;
        _checkReference(varName, stepName, field, outputToStep, getTransitiveDeps, warnings);
      }

      // Scan ${{ args.xxx }} syntax
      TEMPLATE_REF_RE.lastIndex = 0;
      while ((match = TEMPLATE_REF_RE.exec(value)) !== null) {
        const varName = match[1];
        if (FOREACH_LOCALS.has(varName)) continue;
        _checkReference(varName, stepName, field, outputToStep, getTransitiveDeps, warnings);
      }

      // Scan dashed references: $step-name where step-name is an existing step
      DASHED_REF_RE.lastIndex = 0;
      while ((match = DASHED_REF_RE.exec(value)) !== null) {
        const fullName = `${match[1]}-${match[2]}`;
        if (steps[fullName]) {
          const underscored = fullName.replace(/-/g, '_');
          warnings.push({
            step: stepName,
            field,
            reference: `$${fullName}`,
            message: `"$${fullName}" — variable names cannot contain dashes. Use "$${underscored}" instead (step "${fullName}" outputs as "${underscored}")`,
          });
        }
      }
    }
  }

  // ── flatten:false mismatch ──
  // A step that produces its output with `flatten: false` emits an array-of-arrays
  // (one inner array per foreach item). When a downstream step iterates that
  // variable with its own `foreach`, each `$item` is an *inner array*, not an
  // object — so `$item.field` silently resolves to undefined. The fix is to
  // flatten in the foreach expression (`${{ args.x.flat() }}`). Flag the case
  // where that flatten is missing.
  for (const [stepName, step] of Object.entries(steps)) {
    if (!step.foreach) continue;
    if (step.foreach.includes('.flat(')) continue; // already flattened

    // Extract the single top-level variable the foreach iterates.
    let refVar: string | undefined;
    VAR_REF_RE.lastIndex = 0;
    const dollarMatch = VAR_REF_RE.exec(step.foreach);
    if (dollarMatch && !FOREACH_LOCALS.has(dollarMatch[1])) {
      refVar = dollarMatch[1];
    } else {
      TEMPLATE_REF_RE.lastIndex = 0;
      const tplMatch = TEMPLATE_REF_RE.exec(step.foreach);
      if (tplMatch && !FOREACH_LOCALS.has(tplMatch[1])) refVar = tplMatch[1];
    }
    if (!refVar) continue;

    const producer = outputToStep.get(refVar);
    if (!producer || producer === '__input__' || producer === stepName) continue;
    if (steps[producer]?.flatten !== false) continue;

    // Only a bug if this step treats each $item as an *object* (dotted field
    // access). Forwarding the whole inner array via bare `$item` — e.g. passing
    // it as one input to a nested workflow — is a legitimate flatten:false use.
    const usesItemField = [...extractStrings(step.args ?? {}, 'args')].some(([, str]) =>
      /\$item\.[a-zA-Z_]/.test(str) || /\bitem\.[a-zA-Z_]/.test(str),
    );
    if (!usesItemField) continue;

    warnings.push({
      step: stepName,
      field: 'foreach',
      reference: `$${refVar}`,
      message: `"$${refVar}" is produced by step "${producer}" with flatten:false (array-of-arrays). This step reads $item.<field> but each $item is an inner array — use "\${{ args.${refVar}.flat() }}" instead`,
    });
  }

  return warnings;
}

function _checkReference(
  varName: string,
  stepName: string,
  field: string,
  outputToStep: Map<string, string>,
  getTransitiveDeps: (step: string) => Set<string>,
  warnings: ValidationWarning[],
): void {
  const producingStep = outputToStep.get(varName);

  if (!producingStep) {
    warnings.push({
      step: stepName,
      field,
      reference: `$${varName}`,
      message: `references unknown variable "$${varName}"`,
    });
    return;
  }

  // Input variables have no producing step to check in the dependency chain
  if (producingStep === '__input__') return;

  const deps = getTransitiveDeps(stepName);
  if (!deps.has(producingStep)) {
    warnings.push({
      step: stepName,
      field,
      reference: `$${varName}`,
      message: `"$${varName}" produced by step "${producingStep}" is not in dependency chain — add depends_on: [${producingStep}] to step "${stepName}"`,
    });
  }
}

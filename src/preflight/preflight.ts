/**
 * Workflow preflight: comprehensive pre-execution validation.
 *
 * Runs all checks that can catch problems before a workflow executes:
 * YAML parse, DAG validation, variable references, adapter probing,
 * args compatibility, output.map field matching, and environment checks.
 */

import { parseWorkflow, WorkflowParseError } from '../schema/parser.js';
import { DAGScheduler } from '../engine/scheduler.js';
import { validateWorkflow } from '../schema/validator.js';
import { probeAdapter, type ProbeResult } from './probe.js';
import { getRegistry } from '@jackwener/opencli/registry';
import type { WorkflowDefinition, WorkflowStep, StepOutput } from '../schema/types.js';
import * as fs from 'node:fs';

export interface PreflightCheck {
  category: 'parse' | 'dag' | 'vars' | 'adapter' | 'args' | 'output-map' | 'env' | 'nested';
  step?: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
  strategy?: string;
}

export interface PreflightResult {
  workflow: string;
  valid: boolean;
  steps: number;
  checks: PreflightCheck[];
  errors: string[];
  warnings: string[];
  probes: ProbeResult[];
}

export async function preflightWorkflow(
  filePath: string,
  _opts?: { timeout?: number },
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const probes: ProbeResult[] = [];
  let definition: WorkflowDefinition | undefined;

  // 1. YAML parse
  try {
    definition = parseWorkflow(filePath);
    checks.push({ category: 'parse', status: 'pass', message: `Parsed "${definition.name}" (${Object.keys(definition.steps).length} steps)` });
  } catch (err) {
    const msg = err instanceof WorkflowParseError ? err.message : String(err);
    checks.push({ category: 'parse', status: 'fail', message: `YAML parse failed: ${msg}` });
    return buildResult('unknown', checks, probes);
  }

  // 2. DAG validation
  const scheduler = new DAGScheduler(definition.steps);
  const dagResult = scheduler.validate();
  if (dagResult.valid) {
    const waves = scheduler.plan();
    checks.push({ category: 'dag', status: 'pass', message: `DAG valid (${waves.length} layers, no cycles)` });
  } else {
    checks.push({ category: 'dag', status: 'fail', message: `Cycle detected: ${dagResult.cycle?.join(' → ')}` });
  }

  // 3. Variable reference validation
  const varWarnings = validateWorkflow(definition);
  if (varWarnings.length === 0) {
    checks.push({ category: 'vars', status: 'pass', message: 'All variable references resolved' });
  } else {
    for (const w of varWarnings) {
      checks.push({ category: 'vars', status: 'warn', message: `${w.step}.${w.field}: ${w.message}`, detail: w.reference });
    }
  }

  // 4. Per-step checks
  const registry = getRegistry();
  const probedDomains = new Map<string, ProbeResult>();

  for (const [stepName, step] of Object.entries(definition.steps)) {
    if (step.type === 'workflow') {
      checkNestedWorkflow(step, stepName, checks);
      continue;
    }

    const adapterName = step.adapter;
    if (!adapterName) continue;

    const cmd = registry.get(adapterName);

    // 4a. Adapter existence
    if (!cmd) {
      checks.push({ category: 'adapter', step: stepName, status: 'fail', message: `Adapter "${adapterName}" not found`, detail: 'Run "opencli list" to see available adapters' });
      continue;
    }

    // 4b. Adapter probe (cache by domain)
    const domain = cmd.domain || adapterName;
    let probe = probedDomains.get(domain);
    if (!probe) {
      probe = await probeAdapter(cmd);
      probedDomains.set(domain, probe);
    }
    probes.push({ ...probe, adapter: adapterName });

    if (probe.status === 'ok') {
      checks.push({
        category: 'adapter', step: stepName, status: 'pass', strategy: probe.strategy,
        message: `${adapterName} [${probe.strategy}] → ok${probe.latencyMs ? ` (${(probe.latencyMs / 1000).toFixed(1)}s)` : ''}`,
      });
    } else if (probe.status === 'no-bridge') {
      checks.push({
        category: 'adapter', step: stepName, status: 'warn', strategy: probe.strategy,
        message: `${adapterName} [${probe.strategy}] → no-bridge — requires browser extension. Consider using a PUBLIC adapter instead`,
        detail: probe.issue,
      });
    } else {
      // A PUBLIC probe HEADs the adapter's declared `domain`, which is not always
      // the host the adapter actually queries (e.g. hackernews/search declares
      // news.ycombinator.com but fetches hn.algolia.com). A timeout/unreachable
      // here is therefore advisory, not conclusive — downgrade to warn so a
      // wrong-host or transient probe can't block a run that would otherwise
      // succeed (the adapter carries its own on_error: retry). The real verdict
      // comes from the run itself under --strict.
      checks.push({
        category: 'adapter', step: stepName,
        status: 'warn',
        strategy: probe.strategy,
        message: `${adapterName} [${probe.strategy}] → ${probe.status} (probe advisory; the declared domain may differ from the API host)`,
        detail: probe.issue,
      });
    }

    // 4c. Args declaration matching
    if (step.args && cmd.args) {
      const declaredArgs = new Set(cmd.args.map(a => a.name));
      for (const key of Object.keys(step.args)) {
        if (!declaredArgs.has(key)) {
          checks.push({
            category: 'args', step: stepName, status: 'warn',
            message: `Arg "${key}" not declared by ${adapterName}`,
            detail: `Declared args: ${Array.from(declaredArgs).join(', ')}`,
          });
        }
      }
    }

    // 4d. output.map field matching
    if (step.output && typeof step.output === 'object') {
      const spec = step.output as StepOutput;
      if (spec.map && cmd.columns) {
        const columnSet = new Set(cmd.columns);
        for (const [targetField, sourceField] of Object.entries(spec.map)) {
          if (!columnSet.has(sourceField)) {
            checks.push({
              category: 'output-map', step: stepName, status: 'warn',
              message: `output.map "${targetField}: ${sourceField}" — "${sourceField}" not in adapter columns`,
              detail: `Available columns: ${cmd.columns.join(', ')}`,
            });
          }
        }
      }
    }
  }

  // 5. Environment checks
  const hasBrowserSteps = probes.some(p => p.strategy === 'cookie' || p.strategy === 'ui' || p.strategy === 'intercept');
  if (hasBrowserSteps) {
    const bridgeProbe = probes.find(p => p.strategy !== 'public' && p.strategy !== 'local');
    if (bridgeProbe && bridgeProbe.status === 'no-bridge') {
      checks.push({ category: 'env', status: 'fail', message: 'Browser bridge not ready', detail: bridgeProbe.issue });
    } else {
      checks.push({ category: 'env', status: 'pass', message: 'Browser bridge ready' });
    }
  } else {
    checks.push({ category: 'env', status: 'pass', message: 'No browser steps — bridge not needed' });
  }

  return buildResult(definition.name, checks, probes, Object.keys(definition.steps).length);
}

function checkNestedWorkflow(step: WorkflowStep, stepName: string, checks: PreflightCheck[]): void {
  if (!step.workflow) {
    checks.push({ category: 'nested', step: stepName, status: 'fail', message: 'type: workflow step missing "workflow" field' });
    return;
  }

  if (!fs.existsSync(step.workflow)) {
    checks.push({ category: 'nested', step: stepName, status: 'fail', message: `Nested workflow file not found: ${step.workflow}` });
    return;
  }

  try {
    parseWorkflow(step.workflow);
    checks.push({ category: 'nested', step: stepName, status: 'pass', message: `Nested workflow "${step.workflow}" parseable` });
  } catch (err) {
    checks.push({ category: 'nested', step: stepName, status: 'fail', message: `Nested workflow parse error: ${err instanceof Error ? err.message : err}` });
  }
}

function buildResult(workflow: string, checks: PreflightCheck[], probes: ProbeResult[], stepCount = 0): PreflightResult {
  const errors = checks.filter(c => c.status === 'fail').map(c => c.step ? `[${c.step}] ${c.message}` : c.message);
  const warnings = checks.filter(c => c.status === 'warn').map(c => c.step ? `[${c.step}] ${c.message}` : c.message);
  return {
    workflow,
    valid: errors.length === 0,
    steps: stepCount,
    checks,
    errors,
    warnings,
    probes,
  };
}

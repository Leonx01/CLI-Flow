/**
 * Workflow YAML parser and validator.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { WorkflowDefinition, WorkflowStep, WorkflowInput, StepOutput, InteractSpec } from './types.js';

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}

const MAX_WORKFLOW_FILE_SIZE = 1024 * 1024; // 1MB

function parseInteract(stepName: string, raw: unknown): InteractSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowParseError(`Step "${stepName}" interact must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type as string;
  if (!type) {
    throw new WorkflowParseError(`Step "${stepName}" interact must have a "type" field`);
  }

  switch (type) {
    case 'confirm':
      return {
        type: 'confirm',
        message: obj.message !== undefined ? String(obj.message) : undefined,
      };
    case 'select':
    case 'multi-select':
      if (!obj.from || typeof obj.from !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" interact.type="${type}" requires a "from" field (string)`);
      }
      if (!obj.message || typeof obj.message !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" interact.type="${type}" requires a "message" field`);
      }
      return {
        type,
        from: obj.from,
        display: obj.display !== undefined ? String(obj.display) : undefined,
        message: obj.message,
      };
    case 'input':
      if (!obj.message || typeof obj.message !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" interact.type="input" requires a "message" field`);
      }
      return {
        type: 'input',
        message: obj.message,
        default: obj.default !== undefined ? String(obj.default) : undefined,
      };
    default:
      throw new WorkflowParseError(
        `Step "${stepName}" interact.type must be one of: confirm, select, multi-select, input (got "${type}")`,
      );
  }
}

export function parseWorkflow(filePath: string): WorkflowDefinition {
  if (!fs.existsSync(filePath)) {
    throw new WorkflowParseError(`Workflow file not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_WORKFLOW_FILE_SIZE) {
    throw new WorkflowParseError(`Workflow file too large (${stat.size} bytes, max ${MAX_WORKFLOW_FILE_SIZE})`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = yaml.load(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new WorkflowParseError('Workflow YAML must be an object');
  }

  if (!raw.name || typeof raw.name !== 'string') {
    throw new WorkflowParseError('Workflow must have a "name" field (string)');
  }

  if (!raw.steps || typeof raw.steps !== 'object' || Array.isArray(raw.steps)) {
    throw new WorkflowParseError('Workflow must have a "steps" field (object, not array)');
  }

  const rawSteps = raw.steps as Record<string, unknown>;
  const steps: Record<string, WorkflowStep> = {};

  for (const [stepName, stepRaw] of Object.entries(rawSteps)) {
    if (!stepRaw || typeof stepRaw !== 'object' || Array.isArray(stepRaw)) {
      throw new WorkflowParseError(`Step "${stepName}" must be an object`);
    }

    const s = stepRaw as Record<string, unknown>;
    const step: WorkflowStep = {};

    const stepType = (s.type as string) || 'adapter';
    step.type = stepType as 'adapter' | 'workflow';

    // A pure interaction node (select/multi-select/input) produces its output
    // directly from user input and doesn't invoke an adapter at all.
    const rawInteractType = (s.interact as Record<string, unknown> | undefined)?.type;
    const isPureInteractNode = stepType === 'adapter' && s.adapter === undefined
      && typeof rawInteractType === 'string';

    if (stepType === 'adapter') {
      if (!isPureInteractNode) {
        if (!s.adapter || typeof s.adapter !== 'string') {
          throw new WorkflowParseError(`Step "${stepName}" (type: adapter) must have an "adapter" field`);
        }
        step.adapter = s.adapter;
      }
    } else if (stepType === 'ai') {
      throw new WorkflowParseError(
        `Step "${stepName}": type "ai" has been removed. Use an adapter instead:\n` +
        `  ${stepName}:\n` +
        `    adapter: dashscope/chat    # or llm/chat\n` +
        `    args:\n` +
        `      prompt: "your prompt here"\n` +
        `      json_mode: true`,
      );
    } else if (stepType === 'workflow') {
      if (!s.workflow || typeof s.workflow !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" (type: workflow) must have a "workflow" field`);
      }
      step.workflow = path.resolve(path.dirname(filePath), s.workflow);
    } else {
      throw new WorkflowParseError(`Step "${stepName}" has unknown type: ${stepType}`);
    }

    if (s.args !== undefined) {
      if (typeof s.args !== 'object' || Array.isArray(s.args)) {
        throw new WorkflowParseError(`Step "${stepName}" args must be an object`);
      }
      step.args = s.args as Record<string, unknown>;
    }

    if (s.depends_on !== undefined) {
      if (!Array.isArray(s.depends_on)) {
        throw new WorkflowParseError(`Step "${stepName}" depends_on must be an array`);
      }
      step.depends_on = s.depends_on as string[];
    }

    if (s.foreach !== undefined) {
      if (typeof s.foreach !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" foreach must be a string (e.g., "$products")`);
      }
      step.foreach = s.foreach;
    }

    if (s.concurrency !== undefined) {
      step.concurrency = Number(s.concurrency);
      if (!Number.isInteger(step.concurrency) || step.concurrency < 1) {
        throw new WorkflowParseError(`Step "${stepName}" concurrency must be a positive integer`);
      }
    }

    if (s.delay !== undefined) {
      step.delay = Number(s.delay);
      if (!Number.isFinite(step.delay) || step.delay < 0) {
        throw new WorkflowParseError(`Step "${stepName}" delay must be a non-negative number (ms)`);
      }
    }

    if (s.output !== undefined) {
      if (typeof s.output === 'string') {
        step.output = s.output;
      } else if (typeof s.output === 'object' && !Array.isArray(s.output)) {
        const out = s.output as Record<string, unknown>;
        const spec: StepOutput = {};
        if (out.as !== undefined) {
          if (typeof out.as !== 'string') {
            throw new WorkflowParseError(`Step "${stepName}" output.as must be a string`);
          }
          spec.as = out.as;
        }
        if (out.map !== undefined) {
          if (typeof out.map !== 'object' || Array.isArray(out.map)) {
            throw new WorkflowParseError(`Step "${stepName}" output.map must be an object`);
          }
          const map = out.map as Record<string, unknown>;
          for (const [k, v] of Object.entries(map)) {
            if (typeof v !== 'string') {
              throw new WorkflowParseError(`Step "${stepName}" output.map.${k} must be a string (source field name)`);
            }
          }
          spec.map = map as Record<string, string>;
        }
        step.output = spec;
      } else {
        throw new WorkflowParseError(`Step "${stepName}" output must be a string or { as?, map? }`);
      }
    }

    if (s.condition !== undefined) {
      if (typeof s.condition !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" condition must be a string`);
      }
      step.condition = s.condition;
    }

    if (s.on_error !== undefined) {
      const policy = s.on_error as string;
      if (!['stop', 'skip', 'retry'].includes(policy)) {
        throw new WorkflowParseError(`Step "${stepName}" on_error must be stop, skip, or retry`);
      }
      step.on_error = policy as 'stop' | 'skip' | 'retry';
    }

    if (s.retries !== undefined) {
      step.retries = Number(s.retries);
      if (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > 20) {
        throw new WorkflowParseError(`Step "${stepName}" retries must be an integer 0-20`);
      }
    }

    if (s.timeout !== undefined) {
      step.timeout = Number(s.timeout);
      if (!Number.isFinite(step.timeout) || step.timeout <= 0) {
        throw new WorkflowParseError(`Step "${stepName}" timeout must be a positive number (seconds)`);
      }
    }

    if (s.description !== undefined) {
      if (typeof s.description !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" description must be a string`);
      }
      step.description = s.description;
    }

    if (s.flatten !== undefined) {
      if (typeof s.flatten !== 'boolean') {
        throw new WorkflowParseError(`Step "${stepName}" flatten must be boolean`);
      }
      step.flatten = s.flatten;
    }

    if (s.confirm !== undefined) {
      if (typeof s.confirm !== 'boolean' && typeof s.confirm !== 'string') {
        throw new WorkflowParseError(`Step "${stepName}" confirm must be a boolean or string`);
      }
      step.confirm = s.confirm;
    }

    if (s.auth !== undefined) {
      if (typeof s.auth === 'boolean') {
        step.auth = s.auth;
      } else if (typeof s.auth === 'string' && s.auth === 'required') {
        step.auth = true;
      } else if (typeof s.auth === 'object' && s.auth !== null && !Array.isArray(s.auth)) {
        const authObj = s.auth as Record<string, unknown>;
        step.auth = {
          timeout: authObj.timeout !== undefined ? Number(authObj.timeout) : undefined,
          on_timeout: authObj.on_timeout as 'skip' | 'abort' | undefined,
          max_retries: authObj.max_retries !== undefined ? Number(authObj.max_retries) : undefined,
        };
        if (step.auth.timeout !== undefined && (!Number.isFinite(step.auth.timeout) || step.auth.timeout <= 0)) {
          throw new WorkflowParseError(`Step "${stepName}" auth.timeout must be a positive number`);
        }
        if (step.auth.on_timeout !== undefined && !['skip', 'abort'].includes(step.auth.on_timeout)) {
          throw new WorkflowParseError(`Step "${stepName}" auth.on_timeout must be 'skip' or 'abort'`);
        }
      } else {
        throw new WorkflowParseError(`Step "${stepName}" auth must be boolean or object`);
      }

      if (step.auth && !step.adapter) {
        throw new WorkflowParseError(
          `Step "${stepName}" has "auth" but no adapter — auth requires an adapter to determine the site`,
        );
      }
    }

    if (s.interact !== undefined) {
      step.interact = parseInteract(stepName, s.interact);
    }

    steps[stepName] = step;
  }

  // Validate depends_on references
  for (const [stepName, step] of Object.entries(steps)) {
    if (step.depends_on) {
      for (const dep of step.depends_on) {
        if (!steps[dep]) {
          throw new WorkflowParseError(
            `Step "${stepName}" depends on "${dep}" which does not exist`
          );
        }
      }
    }
  }

  let workflowOnError: WorkflowDefinition['on_error'];
  if (raw.on_error !== undefined) {
    const policy = raw.on_error as string;
    if (!['stop', 'skip', 'retry'].includes(policy)) {
      throw new WorkflowParseError(`Workflow on_error must be stop, skip, or retry (got "${policy}")`);
    }
    workflowOnError = policy as 'stop' | 'skip' | 'retry';
  }

  let workflowTimeout: number | undefined;
  if (raw.timeout !== undefined) {
    workflowTimeout = Number(raw.timeout);
    if (!Number.isFinite(workflowTimeout) || workflowTimeout <= 0) {
      throw new WorkflowParseError('Workflow timeout must be a positive number (seconds)');
    }
  }

  let maxParallel: number | undefined;
  if (raw.max_parallel !== undefined) {
    maxParallel = Number(raw.max_parallel);
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 100) {
      throw new WorkflowParseError('Workflow max_parallel must be an integer 1-100');
    }
  }

  let inputs: Record<string, WorkflowInput> | undefined;
  const rawInputs = raw.inputs ?? raw.input;  // Accept both 'inputs' (canonical) and 'input' (shorthand)
  if (rawInputs !== undefined) {
    if (typeof rawInputs !== 'object' || Array.isArray(rawInputs)) {
      throw new WorkflowParseError('Workflow inputs must be an object');
    }
    inputs = {};
    for (const [name, spec] of Object.entries(rawInputs as Record<string, unknown>)) {
      if (spec === null || spec === undefined) {
        inputs[name] = {};
        continue;
      }
      if (typeof spec !== 'object' || Array.isArray(spec)) {
        throw new WorkflowParseError(`Workflow input "${name}" must be an object or null`);
      }
      const s = spec as Record<string, unknown>;
      const input: WorkflowInput = {};
      if (s.type !== undefined) {
        const validTypes = ['string', 'number', 'boolean', 'array', 'object'];
        if (!validTypes.includes(s.type as string)) {
          throw new WorkflowParseError(`Workflow input "${name}" type must be one of: ${validTypes.join(', ')}`);
        }
        input.type = s.type as WorkflowInput['type'];
      }
      if (s.required !== undefined) input.required = Boolean(s.required);
      if (s.default !== undefined) input.default = s.default;
      if (s.description !== undefined) input.description = String(s.description);
      inputs[name] = input;
    }
  }

  let outputs: string[] | undefined;
  if (raw.outputs !== undefined) {
    if (!Array.isArray(raw.outputs)) {
      throw new WorkflowParseError('Workflow outputs must be an array of strings');
    }
    for (const o of raw.outputs) {
      if (typeof o !== 'string') {
        throw new WorkflowParseError('Workflow outputs entries must be strings');
      }
    }
    outputs = raw.outputs as string[];
  }

  return {
    name: raw.name as string,
    description: raw.description as string | undefined,
    inputs,
    outputs,
    steps,
    checkpoint: raw.checkpoint === true,
    on_error: workflowOnError,
    timeout: workflowTimeout,
    max_parallel: maxParallel,
  };
}

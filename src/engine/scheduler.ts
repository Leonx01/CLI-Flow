/**
 * DAG scheduler: topological sort, cycle detection, ready-step computation.
 */

import type { WorkflowStep, ExecutionWave } from '../schema/types.js';

export class CycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Cycle detected in workflow DAG: ${cycle.join(' → ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

export class DAGScheduler {
  private readonly steps: Record<string, WorkflowStep>;
  private readonly stepNames: string[];
  private readonly dependents: Map<string, Set<string>>;
  private readonly dependencies: Map<string, Set<string>>;

  constructor(steps: Record<string, WorkflowStep>) {
    this.steps = steps;
    this.stepNames = Object.keys(steps);
    this.dependents = new Map();
    this.dependencies = new Map();

    for (const name of this.stepNames) {
      this.dependents.set(name, new Set());
      this.dependencies.set(name, new Set(steps[name].depends_on ?? []));
    }

    for (const [name, step] of Object.entries(steps)) {
      for (const dep of step.depends_on ?? []) {
        this.dependents.get(dep)?.add(name);
      }
    }
  }

  validate(): { valid: boolean; cycle?: string[] } {
    try {
      this._topologicalSort();
      return { valid: true };
    } catch (err) {
      if (err instanceof CycleError) {
        return { valid: false, cycle: err.cycle };
      }
      throw err;
    }
  }

  getReady(completed: Set<string>, failed?: Set<string>): string[] {
    const ready: string[] = [];
    for (const name of this.stepNames) {
      if (completed.has(name)) continue;
      if (failed?.has(name)) continue;
      const deps = this.dependencies.get(name)!;
      const allDepsResolved = [...deps].every(d => {
        if (completed.has(d)) return true;
        if (failed?.has(d)) return false;
        return false;
      });
      if (allDepsResolved) {
        const anyDepFailed = [...deps].some(d => failed?.has(d));
        if (!anyDepFailed) ready.push(name);
      }
    }
    return ready;
  }

  plan(): ExecutionWave[] {
    const sorted = this._topologicalSort();
    const waves: ExecutionWave[] = [];
    const completed = new Set<string>();

    while (completed.size < sorted.length) {
      const ready = this.getReady(completed);
      if (ready.length === 0) break;
      waves.push({ parallel: ready });
      for (const name of ready) {
        completed.add(name);
      }
    }

    return waves;
  }

  private _topologicalSort(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: string[] = [];

    const visit = (name: string, path: string[]) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        const cycleStart = path.indexOf(name);
        throw new CycleError([...path.slice(cycleStart), name]);
      }

      visiting.add(name);
      path.push(name);

      for (const dep of this.dependencies.get(name) ?? []) {
        visit(dep, [...path]);
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(name);
    };

    for (const name of this.stepNames) {
      visit(name, []);
    }

    return sorted;
  }
}

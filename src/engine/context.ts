/**
 * Workflow variable context: stores step outputs, resolves $varname references.
 */

import { render, type RenderContext } from '../util/template.js';
import { log } from '../util/utils.js';

export class WorkflowContext {
  private vars = new Map<string, unknown>();

  set(name: string, value: unknown): void {
    this.vars.set(name, value);
  }

  get(name: string): unknown {
    return this.vars.get(name);
  }

  has(name: string): boolean {
    return this.vars.has(name);
  }

  /** Resolve a template string. Supports $varname and ${{ expr }} syntax. */
  resolve(template: unknown, item?: unknown, index?: number): unknown {
    if (typeof template !== 'string') return template;

    // Convert $varname to ${{ args.varname }} for the pipeline template engine
    // (resolvePath uses args.x for top-level variable access)
    let normalized = template.replace(
      /\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
      (match, name) => {
        if (name === 'item' || name === 'index') return match;
        return `\${{ args.${name} }}`;
      },
    );

    // Also convert $item.xxx to ${{ item.xxx }}
    normalized = normalized.replace(
      /\$item\.([a-zA-Z0-9_.-]+)/g,
      (_match, path) => `\${{ item.${path} }}`,
    );

    // Convert standalone $item to ${{ item }}
    normalized = normalized.replace(/\$item(?![.\w])/g, '${{ item }}');

    // Convert $index to ${{ index }}
    normalized = normalized.replace(/\$index/g, '${{ index }}');

    const ctx: RenderContext = {
      args: Object.fromEntries(this.vars),
      item,
      index,
    };

    const result = render(normalized, ctx);
    if (result === undefined || result === 'undefined') {
      log.debug?.(`Variable resolution returned undefined for: "${template}"`);
    }
    return result;
  }

  /** Recursively resolve all string values within nested structures (arrays/objects). */
  resolveDeep(value: unknown, item?: unknown, index?: number): unknown {
    if (typeof value === 'string') {
      return this.resolve(value, item, index);
    }
    if (Array.isArray(value)) {
      return value.map(v => this.resolveDeep(v, item, index));
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = this.resolveDeep(v, item, index);
      }
      return result;
    }
    return value;
  }

  /** Resolve all values in an args object. Objects/arrays are JSON-stringified for CLI adapters. */
  resolveArgs(
    args: Record<string, unknown>,
    item?: unknown,
    index?: number,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      let val = this.resolveDeep(value, item, index);
      // CLI args are strings — serialize objects/arrays to JSON so adapters can parse them
      if (val !== null && val !== undefined && typeof val === 'object') {
        val = JSON.stringify(val);
      }
      resolved[key] = val;
    }
    return resolved;
  }

  /** Resolve all values preserving original types. Use for workflow-to-workflow data passing. */
  resolveArgsTyped(
    args: Record<string, unknown>,
    item?: unknown,
    index?: number,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      resolved[key] = this.resolveDeep(value, item, index);
    }
    return resolved;
  }

  /** Serialize context for checkpoint. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.vars);
  }

  /**
   * Extract top-level workflow variable names referenced by a template string —
   * the same `$varname` / `${{ args.varname }}` tokens that `resolve()` would
   * substitute, excluding `$item`/`$index` (those come from the foreach loop,
   * not the workflow context). Used by the engine's pre-launch precheck: a
   * referenced variable that isn't `set` yet means the producing step was
   * skipped/failed, so this step should skip too rather than run on undefined.
   */
  extractVarRefs(template: unknown): string[] {
    if (typeof template !== 'string') return [];
    const refs = new Set<string>();
    for (const m of template.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      if (m[1] === 'item' || m[1] === 'index') continue;
      refs.add(m[1]);
    }
    for (const m of template.matchAll(/\$\{\{(.*?)\}\}/g)) {
      const block = m[1];
      const varMatch = block.match(/\bargs\.([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (!varMatch) continue;
      if (/\|\s*default\s*\(/.test(block)) continue;
      refs.add(varMatch[1]);
    }
    return [...refs];
  }

  /**
   * Recursively extract workflow variable references from any value structure.
   * Walks arrays, objects, and strings to find all $varname / ${{ args.varname }}
   * references nested at any depth. Used by collectMissingVarRefs for deep args.
   */
  extractVarRefsDeep(value: unknown): string[] {
    const refs = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === 'string') {
        for (const name of this.extractVarRefs(v)) refs.add(name);
      } else if (Array.isArray(v)) {
        for (const item of v) walk(item);
      } else if (v !== null && typeof v === 'object') {
        for (const val of Object.values(v as Record<string, unknown>)) walk(val);
      }
    };
    walk(value);
    return [...refs];
  }

  /** Restore context from checkpoint data. */
  static fromJSON(data: Record<string, unknown>): WorkflowContext {
    const ctx = new WorkflowContext();
    for (const [key, value] of Object.entries(data)) {
      ctx.set(key, value);
    }
    return ctx;
  }
}

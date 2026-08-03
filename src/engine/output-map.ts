/**
 * Output mapping for workflow step results.
 *
 * Extracted from engine.ts. Handles:
 * - Variable naming (step name → output variable name)
 * - Field mapping via output.map spec
 * - Constant value injection (values not matching a source field)
 * - Dot-path nested field access (e.g. "author.name")
 */

import type { StepOutput } from '../schema/types.js';

/**
 * Apply the output spec (as/map) to raw step data.
 * Returns the variable name and the (possibly mapped) value.
 */
export function applyOutputMap(
  data: unknown,
  outputSpec: string | StepOutput | undefined,
  stepName: string,
): { varName: string; mapped: unknown } {
  const spec = typeof outputSpec === 'string'
    ? { as: outputSpec }
    : outputSpec ?? {};
  const varName = spec.as ?? stepName.replace(/-/g, '_');

  if (!spec.map) return { varName, mapped: data };

  if (Array.isArray(data)) {
    return { varName, mapped: data.map(item => mapFields(item, spec.map!)) };
  }
  if (data && typeof data === 'object') {
    return { varName, mapped: mapFields(data, spec.map) };
  }
  return { varName, mapped: data };
}

/**
 * Map fields from a source object using a mapping spec.
 *
 * Supports three value forms in the map:
 * 1. Simple field name: `title: "name"` → takes source["name"]
 * 2. Dot-path: `authorName: "author.name"` → walks source.author.name
 * 3. Constant fallback: if the value doesn't match any source field or
 *    dot-path, it's injected as a literal constant (e.g. `source: "hackernews"`)
 *
 * Strategy is "field-first" for backward compatibility: if source has a key
 * matching the value exactly, that field is used even if it looks like a constant.
 */
export function mapFields(
  item: unknown,
  map: Record<string, string>,
): Record<string, unknown> {
  if (!item || typeof item !== 'object') return {};
  const source = item as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [targetKey, sourceExpr] of Object.entries(map)) {
    // 1. Exact field match (field-first for backward compat)
    if (sourceExpr in source) {
      result[targetKey] = source[sourceExpr];
      continue;
    }

    // 2. Dot-path nested access (e.g. "author.name")
    if (sourceExpr.includes('.')) {
      const resolved = resolveDotPath(source, sourceExpr);
      if (resolved !== undefined) {
        result[targetKey] = resolved;
        continue;
      }
    }

    // 3. Constant fallback — value doesn't match any field, inject as literal
    result[targetKey] = sourceExpr;
  }

  return result;
}

function resolveDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

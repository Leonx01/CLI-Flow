/**
 * Prefs: persist and recall user interaction preferences.
 *
 * Saves each interact answer to ~/.cliflow/prefs/<workflow>.json so that
 * subsequent runs can pre-fill the UI with previous choices.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ResolvedInteractSpec, WorkflowCallbacks } from '../schema/types.js';

const PREFS_DIR = path.join(os.homedir(), '.cliflow', 'prefs');

export interface PrefEntry {
  value: unknown;
  savedAt: number;
}

export type PrefStore = Record<string, PrefEntry>;

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, '_');
}

function prefsPath(workflowName: string): string {
  return path.join(PREFS_DIR, `${sanitizeName(workflowName)}.json`);
}

export function loadPrefs(workflowName: string): PrefStore {
  const filePath = prefsPath(workflowName);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PrefStore;
  } catch {
    return {};
  }
}

export function savePrefs(workflowName: string, store: PrefStore): void {
  if (!fs.existsSync(PREFS_DIR)) {
    fs.mkdirSync(PREFS_DIR, { recursive: true });
  }
  const filePath = prefsPath(workflowName);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function deletePrefs(workflowName: string): boolean {
  const filePath = prefsPath(workflowName);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function listPrefs(): Array<{ workflow: string; entries: number; updatedAt: number }> {
  if (!fs.existsSync(PREFS_DIR)) return [];
  const results: Array<{ workflow: string; entries: number; updatedAt: number }> = [];
  for (const file of fs.readdirSync(PREFS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(PREFS_DIR, file), 'utf-8');
      const store = JSON.parse(content) as PrefStore;
      const entries = Object.keys(store).length;
      const maxSavedAt = Math.max(0, ...Object.values(store).map(e => e.savedAt || 0));
      results.push({
        workflow: file.replace(/\.json$/, ''),
        entries,
        updatedAt: maxSavedAt,
      });
    } catch {
      // skip corrupted
    }
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Check if a saved pref value is still valid for the current spec options. */
function prefMatchesSpec(spec: ResolvedInteractSpec, value: unknown): boolean {
  switch (spec.type) {
    case 'confirm':
      return typeof value === 'boolean';
    case 'input':
      return typeof value === 'string';
    case 'select': {
      const json = JSON.stringify(value);
      return spec.options.some(o => JSON.stringify(o.value) === json);
    }
    case 'multi-select': {
      if (!Array.isArray(value)) return false;
      const optionKeys = new Set(spec.options.map(o => JSON.stringify(o.value)));
      return value.length > 0 && value.every(v => optionKeys.has(JSON.stringify(v)));
    }
    case 'auth':
      return false;
  }
}

export function wrapCallbacksWithPrefs(
  callbacks: WorkflowCallbacks,
  workflowName: string,
  options: { inject: boolean },
): WorkflowCallbacks {
  if (!callbacks.onInteract) return callbacks;

  const originalOnInteract = callbacks.onInteract;
  let store: PrefStore | null = null;

  return {
    ...callbacks,
    onInteract: async (stepName: string, spec: ResolvedInteractSpec): Promise<unknown> => {
      if (spec.type === 'auth') {
        return originalOnInteract(stepName, spec);
      }

      if (!store) {
        store = loadPrefs(workflowName);
      }

      const leafName = stepName.split('/').pop() || stepName;

      if (options.inject) {
        const pref = store[leafName];
        if (pref && prefMatchesSpec(spec, pref.value)) {
          return pref.value;
        }
        // pref missing or stale (options changed) → fall through to normal UI
      }

      const result = await originalOnInteract(stepName, spec);

      store[leafName] = { value: result, savedAt: Date.now() };
      try {
        savePrefs(workflowName, store);
      } catch {
        // best-effort save
      }

      return result;
    },
  };
}

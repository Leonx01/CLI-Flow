/**
 * Interact abstraction layer — decouples interaction handling from renderers.
 *
 * Provides:
 * - InteractProvider: UI layer that renders prompts and collects user answers
 * - InteractPolicy: strategy layer that auto-resolves interactions without user input
 * - createInteractHandler: composes provider + policy into an onInteract callback
 */

import type { ResolvedInteractSpec } from '../schema/types.js';

// ── Interfaces ─────────────────────────────────────────────────────────────

/** Strategy for resolving interactions without user input. */
export interface InteractPolicy {
  resolve(stepName: string, spec: ResolvedInteractSpec): unknown | undefined;
}

/** Interactive UI provider — renders prompts and collects user answers. */
export interface InteractProvider {
  prompt(stepName: string, spec: ResolvedInteractSpec): Promise<unknown>;
  supports?(type: string): boolean;
}

// ── Pause signal (agent-mode) ──────────────────────────────────────────────

/** Thrown by PAUSE_POLICY to signal the engine to pause and emit the interact spec. */
export class InteractPauseSignal extends Error {
  constructor(public stepName: string, public spec: ResolvedInteractSpec) {
    super(`Workflow paused: interact at step "${stepName}"`);
    this.name = 'InteractPauseSignal';
  }
}

// ── Built-in policies ──────────────────────────────────────────────────────

function autoResolveSpec(spec: ResolvedInteractSpec): unknown {
  switch (spec.type) {
    case 'confirm': return spec.defaultValue ?? true;
    case 'select': return spec.defaultValue ?? spec.options[0]?.value;
    case 'multi-select': return spec.defaultValues ?? spec.options.map(o => o.value);
    case 'input': return spec.default ?? '';
    case 'auth': return 'skip';
  }
}

/** Auto-approve all confirms, select first option, return defaults, skip auth. */
export const AUTO_APPROVE_POLICY: InteractPolicy = {
  resolve(_stepName: string, spec: ResolvedInteractSpec): unknown {
    return autoResolveSpec(spec);
  },
};

/** Auto-reject all confirms, skip auth, return empty for selections. */
export const AUTO_REJECT_POLICY: InteractPolicy = {
  resolve(_stepName: string, spec: ResolvedInteractSpec): unknown {
    switch (spec.type) {
      case 'confirm': return false;
      case 'select': return undefined;
      case 'multi-select': return [];
      case 'input': return 'default' in spec ? (spec.default ?? '') : '';
      case 'auth': return 'skip';
    }
  },
};

/** Pause workflow on any interact — throws InteractPauseSignal for engine to catch. */
export const PAUSE_POLICY: InteractPolicy = {
  resolve(stepName: string, spec: ResolvedInteractSpec): unknown {
    throw new InteractPauseSignal(stepName, spec);
  },
};

// ── Composer ────────────────────────────────────────────────────────────────

/** Compose a policy + provider into the onInteract callback shape. */
export function createInteractHandler(
  provider: InteractProvider | null,
  policy?: InteractPolicy,
): (stepName: string, spec: ResolvedInteractSpec) => Promise<unknown> {
  return async (stepName: string, spec: ResolvedInteractSpec): Promise<unknown> => {
    if (policy) {
      const resolved = policy.resolve(stepName, spec);
      if (resolved !== undefined) return resolved;
    }
    if (provider) {
      if (provider.supports && !provider.supports(spec.type)) {
        return autoResolveSpec(spec);
      }
      return provider.prompt(stepName, spec);
    }
    return autoResolveSpec(spec);
  };
}

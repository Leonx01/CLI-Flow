import type { WorkflowDefinition, ResolvedInteractSpec } from '../schema/types.js';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'interacting' | 'retrying' | 'blocked';

export interface StepUIState {
  stepName: string;
  status: StepStatus;
  startedAt?: number;
  durationMs?: number;
  error?: string;
  skipReason?: string;
  foreachProgress?: { completed: number; total: number; failed: number };
  foreachErrors?: string[];
  outputPaths?: string[];
  output?: { varName: string; value: unknown };
  retry?: { current: number; max: number };
}

export interface WorkflowUIState {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'paused';
  stepStatus: Record<string, StepUIState>;
  startedAt?: number;
  elapsedMs?: number;
  pendingInteract?: {
    stepName: string;
    spec: ResolvedInteractSpec;
  } | null;
}

export interface WSMessage {
  type: string;
  stepName?: string;
  status?: string;
  startedAt?: number;
  durationMs?: number;
  error?: string;
  skipReason?: string;
  foreachProgress?: { completed: number; total: number; failed: number };
  output?: { varName: string; value: unknown };
  reason?: string;
  attempt?: number;
  maxRetries?: number;
  foreachErrors?: string[];
  result?: unknown;
  spec?: ResolvedInteractSpec;
  answer?: unknown;
  message?: string;
  workflow?: string;
  totalSteps?: number;
  runId?: string;
}

export interface FlowNodeData {
  label: string;
  step?: Record<string, unknown>;
  status: StepStatus;
  description?: string;
  adapter?: string;
  workflow?: string;
  foreach?: string;
  durationMs?: number;
  error?: string;
  foreachProgress?: { completed: number; total: number; failed: number };
  foreachErrors?: string[];
  outputPaths?: string[];
  interactMessage?: string;
}

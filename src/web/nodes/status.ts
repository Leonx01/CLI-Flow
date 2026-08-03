/**
 * Shared status → color mapping for web nodes. Values must stay in sync
 * with the CSS variables in ../style.css.
 */

import type { StepStatus } from '../types.js';

export const STATUS_COLORS: Record<StepStatus, string> = {
  pending: '#8c959f',
  blocked: '#a0a8b0',
  running: '#d97706',
  completed: '#2da44e',
  failed: '#cf222e',
  skipped: '#8c959f',
  retrying: '#bf8700',
  interacting: '#8250df',
};

export const STATUS_ICONS: Record<StepStatus, string> = {
  pending: '○',
  blocked: '⊘',
  running: '◉',
  completed: '✓',
  failed: '✗',
  skipped: '⊘',
  retrying: '↻',
  interacting: '?',
};

export const STATUS_LABELS: Record<StepStatus, string> = {
  pending: 'Pending',
  blocked: 'Blocked',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  retrying: 'Retrying',
  interacting: 'Waiting',
};

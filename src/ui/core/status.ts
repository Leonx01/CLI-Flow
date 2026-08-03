import type { Status, WorkflowNode } from './types.js';

// ---------------------------------------------------------------------------
// Visual grammar: how each status maps to an icon + color.
// Colors follow the reference TUI: orange = active/focus, green = success,
// red = failure, yellow = retrying/partial-fail, blue = interacting,
// gray = de-emphasized (pending / blocked / skipped).
// ---------------------------------------------------------------------------

export const COLORS = {
  orange: '#E8804D',  // running
  green:  '#3FB950',  // done
  red:    '#F85149',  // failed
  yellow: '#D29922',  // retrying / partial-fail
  purple: '#D8B4FE',  // interacting (soft lavender)
  cyan:   '#3DD6D0',  // 状态栏分割线
  gray:   '#8B949E',  // pending/skipped
  dim:    '#5A6069',  // blocked/辅助信息
  white:  '#E6EDF3',  // 正常文字
} as const;

// ---------------------------------------------------------------------------
// Braille spinner frames
// ---------------------------------------------------------------------------

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function getSpinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
}

// ---------------------------------------------------------------------------
// Status style
// ---------------------------------------------------------------------------

export interface StatusStyle {
  icon: string;
  color: string;
  bold?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

/**
 * Map a status to its visual style.
 * @param status - the node status
 * @param isSubWorkflow - if true, use ◈ icon following status color
 */
export function statusStyle(status: Status, isSubWorkflow?: boolean): StatusStyle {
  if (isSubWorkflow) {
    const base = statusStyleInternal(status);
    return { ...base, icon: '◈' };
  }
  return statusStyleInternal(status);
}

function statusStyleInternal(status: Status): StatusStyle {
  switch (status) {
    case 'done':
      return { icon: '✓', color: COLORS.green, dim: false, strikethrough: false };
    case 'running':
      // For running, caller should use getSpinnerFrame(tick) to animate
      return { icon: '⠋', color: COLORS.orange, bold: false, dim: false, strikethrough: false };
    case 'failed':
      return { icon: '✗', color: COLORS.red, bold: true, dim: false, strikethrough: false };
    case 'retrying':
      return { icon: '↻', color: COLORS.yellow, bold: false, dim: false, strikethrough: false };
    case 'skipped':
      return { icon: '⊘', color: COLORS.gray, dim: true, strikethrough: false };
    case 'blocked':
      return { icon: '□', color: COLORS.dim, dim: true, strikethrough: false };
    case 'interacting':
      return { icon: '◆', color: COLORS.purple, bold: true, dim: false, strikethrough: false };
    case 'pending':
    default:
      return { icon: '□', color: COLORS.gray, dim: false, strikethrough: false };
  }
}

/**
 * Return a "done(partial-fail)" style: ✓ yellow when some children failed
 * but the overall workflow is considered done.
 */
export function donePartialFailStyle(): StatusStyle {
  return { icon: '✓', color: COLORS.yellow, bold: false, dim: false, strikethrough: false };
}

// ---------------------------------------------------------------------------
// Status aggregation: a workflow node's status is derived bottom-up from its
// children, never set directly.
// ---------------------------------------------------------------------------

export function deriveStatus(node: WorkflowNode): Status {
  if (node.type === 'step' || !node.children || node.children.length === 0) {
    return node.status ?? 'pending';
  }

  // If the engine explicitly marked this node as 'done' (e.g. foreach completed
  // with on_error:skip — some items failed but step itself succeeded), trust it.
  // This prevents child-level failures from overriding the authoritative engine status.
  if (node.status === 'done') return 'done';

  const childStatuses = node.children.map(deriveStatus);

  if (childStatuses.some((s) => s === 'interacting')) return 'interacting';
  if (childStatuses.some((s) => s === 'retrying')) return 'retrying';
  if (childStatuses.some((s) => s === 'failed')) return 'failed';
  if (childStatuses.some((s) => s === 'running')) return 'running';
  if (childStatuses.every((s) => s === 'done' || s === 'skipped')) return 'done';
  if (childStatuses.some((s) => s === 'done')) return 'running';
  if (childStatuses.some((s) => s === 'blocked') && !childStatuses.some((s) => s === 'pending')) {
    return 'blocked';
  }
  return 'pending';
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface Progress {
  done: number;
  total: number;
}

/** Count of directly-contained leaf-equivalent progress (done+skipped / total). */
export function deriveProgress(node: WorkflowNode): Progress {
  if (!node.children || node.children.length === 0) {
    const s = node.status ?? 'pending';
    return { done: s === 'done' || s === 'skipped' ? 1 : 0, total: 1 };
  }
  return node.children.reduce<Progress>(
    (acc, child) => {
      const p = deriveProgress(child);
      return { done: acc.done + p.done, total: acc.total + p.total };
    },
    { done: 0, total: 0 },
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatTokens(tokens?: number): string | undefined {
  if (tokens === undefined) return undefined;
  if (tokens >= 1000) return `↑${(tokens / 1000).toFixed(1)}k`;
  return `↑${tokens}`;
}

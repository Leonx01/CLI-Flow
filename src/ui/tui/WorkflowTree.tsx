import { Box, Text } from 'ink';
import type { WorkflowNode, FlatRow, Status } from '../core/types.js';
import {
  COLORS,
  deriveStatus,
  deriveProgress,
  formatDuration,
  getSpinnerFrame,
  statusStyle,
  donePartialFailStyle,
} from '../core/status.js';

// ---------------------------------------------------------------------------
// Meta text: rendered to the right of the label in gray
// ---------------------------------------------------------------------------

function buildMeta(node: WorkflowNode, now?: number): string | undefined {
  const parts: string[] = [];
  const status = deriveStatus(node);
  const meta = node.meta;

  // Blocked-by hint for pending/blocked steps
  if ((status === 'pending' || status === 'blocked') && meta?.dependsOn && meta.dependsOn.length > 0) {
    const displayDeps = meta.dependsOnDisplay ?? meta.dependsOn;
    return `(blocked by ${displayDeps.join(', ')})`;
  }

  // Foreach progress: "(running · 7/10 · 2 failed)" or "(5/5)"
  if (meta?.foreachProgress) {
    const fp = meta.foreachProgress;
    if (status === 'running') parts.push('running');
    parts.push(`${fp.completed}/${fp.total}`);
    if (fp.failed > 0) parts.push(`${fp.failed} failed`);
    return parts.length ? `(${parts.join(' · ')})` : undefined;
  }

  // Workflow node with children: aggregate progress
  if (node.type === 'workflow' && node.children?.length) {
    const { done, total } = deriveProgress(node);
    if (status === 'running') parts.push('running');
    parts.push(`${done}/${total}`);
  }

  // Retry info
  if (meta?.retry && meta.retry.current > 0) {
    parts.push(`retry ${meta.retry.current}/${meta.retry.max}`);
  }

  // Duration: running shows elapsed, done/failed shows final duration
  if (status === 'running' && meta?.startedAt && now) {
    const elapsed = now - meta.startedAt;
    const dur = formatDuration(elapsed);
    if (dur) parts.push(dur);
  } else if (meta?.durationMs !== undefined && (status === 'done' || status === 'failed')) {
    const dur = formatDuration(meta.durationMs);
    if (dur) parts.push(dur);
  }

  // Iteration count for children of foreach nodes
  if (meta?.iterationTotal && meta.iterationTotal > 1) {
    parts.push(`${meta.iterationCompleted ?? 0}/${meta.iterationTotal}`);
  }

  return parts.length ? `(${parts.join(' · ')})` : undefined;
}

// ---------------------------------------------------------------------------
// Row — renders a single tree line
// ---------------------------------------------------------------------------

interface RowProps {
  row: FlatRow;
  selected: boolean;
  spinnerTick: number;
  now: number;
  interactPending?: boolean;
}

function Row({ row, selected, spinnerTick, now, interactPending }: RowProps) {
  const { node, prefix, connector } = row;
  const status = deriveStatus(node);
  const isSubWorkflow = node.type === 'workflow' && !!node.children && node.children.length > 0;
  const isPartialFail = status === 'done' && (node.meta?.foreachProgress?.failed ?? 0) > 0;
  const style = isPartialFail ? donePartialFailStyle() : statusStyle(status, isSubWorkflow);

  // Icon: sub-workflow uses ◈, running uses spinner frame, others use status icon
  let icon: string;
  if (isSubWorkflow) {
    icon = '◈';
  } else if (status === 'running') {
    icon = getSpinnerFrame(spinnerTick);
  } else {
    icon = style.icon;
  }

  // Label color
  let labelColor: string = COLORS.white;
  let labelBold = false;
  let labelDim = false;
  let labelStrikethrough = false;

  switch (status) {
    case 'running':
      break;
    case 'done':
      labelDim = true;
      labelStrikethrough = true;
      labelColor = COLORS.gray;
      break;
    case 'failed':
      // labelDim = true;
      labelColor = COLORS.red;
      // labelBold = true;
      labelColor = COLORS.gray;
      break;
    case 'interacting':
      labelColor = COLORS.purple;
      labelBold = true;
      break;
    case 'pending':
      labelColor = COLORS.gray;
      break;
    case 'blocked':
      labelColor = COLORS.dim;
      labelDim = true;
      break;
    case 'retrying':
      labelColor = COLORS.yellow;
      break;
    case 'skipped':
      labelColor = COLORS.gray;
      labelDim = true;
      break;
  }

  const meta = buildMeta(node, now);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLORS.dim}>{prefix}{connector}</Text>
        <Text color={style.color} bold={status === 'running'}>
          {icon}{' '}
        </Text>
        {node.order ? <Text color={COLORS.dim}>{node.order}{' '}</Text> : null}
        <Text
          color={selected ? COLORS.white : labelColor}
          bold={labelBold}
          dimColor={labelDim}
          strikethrough={labelStrikethrough}
          inverse={selected}
        >
          {node.label}
        </Text>
        {node.blockedBy ? (
          <Text color={COLORS.dim}>{'  › blocked by '}{node.blockedBy}</Text>
        ) : null}
        {meta ? <Text color={COLORS.gray}>{'  '}{meta}</Text> : null}
        {interactPending && status === 'interacting' ? <Text color={COLORS.dim}>{' (awaiting)'}</Text> : null}
      </Box>
      {/* Error line beneath the row */}
      {node.meta?.error && status === 'failed' ? (
        <Box>
          <Text color={COLORS.dim}>{prefix}{'   '}</Text>
          <Text color={COLORS.red}>
            {'⎿ '}{node.meta.error.length > 120 ? node.meta.error.slice(0, 120) + '…' : node.meta.error}
          </Text>
        </Box>
      ) : null}
      {/* Skip reason line beneath skipped steps */}
      {node.meta?.error && status === 'skipped' && (node.meta.skipReason === 'on_error_skip' || node.meta.skipReason === 'missing_var') ? (
        <Box>
          <Text color={COLORS.dim}>{prefix}{'   '}</Text>
          <Text color={COLORS.dim}>
            {'⎿ '}{node.meta.error.length > 120 ? node.meta.error.slice(0, 120) + '…' : node.meta.error}
          </Text>
        </Box>
      ) : null}
      {/* Output path line beneath the row */}
      {node.meta?.outputPath && status === 'done' ? (
        <Box>
          <Text color={COLORS.dim}>{prefix}{'   '}</Text>
          <Text color={COLORS.green} dimColor>
            {'⎿ Output: '}{node.meta.outputPath}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// WorkflowTree — main tree component
// ---------------------------------------------------------------------------

interface WorkflowTreeProps {
  rows: FlatRow[];
  selectedIndex: number;
  spinnerTick: number;
  workflowName: string;
  elapsedMs: number;
  progress: { done: number; total: number };
  workflowStatus: Status;
  interactDismissed?: boolean;
}

export function WorkflowTree({
  rows,
  selectedIndex,
  spinnerTick,
  workflowName,
  elapsedMs,
  progress,
  workflowStatus,
  interactDismissed,
}: WorkflowTreeProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Title bar */}
      <Box>
        <Text color={workflowStatus === 'done' ? COLORS.green : workflowStatus === 'failed' ? COLORS.red : COLORS.orange}>
          {workflowStatus === 'done' ? '✓ ' : workflowStatus === 'failed' ? '✗ ' : '● '}
        </Text>
        <Text color={COLORS.white} bold>
          {workflowName}
        </Text>
        <Text color={COLORS.dim}>
          {'  ('}
          {formatDuration(elapsedMs) ?? '0s'}
          {' · '}
          {progress.done}/{progress.total}
          {')'}
        </Text>
      </Box>

      {/* Tree rows (skip root at index 0) */}
      {rows.slice(1).map((row, i) => (
        <Row
          key={row.path || row.node.id}
          row={row}
          selected={i + 1 === selectedIndex}
          spinnerTick={spinnerTick}
          now={Date.now()}
          interactPending={interactDismissed}
        />
      ))}
    </Box>
  );
}

import React from 'react';
import type { WorkflowStep } from '../../schema/types.js';
import type { StepUIState } from '../types.js';
import { STATUS_COLORS, STATUS_LABELS } from '../nodes/status.js';

interface DetailPanelProps {
  stepName: string | null;
  step?: WorkflowStep;
  status?: StepUIState;
}

/** Keep only the last path segment for display. */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export default function DetailPanel({ stepName, step, status }: DetailPanelProps) {
  if (!stepName) {
    return React.createElement('div', {
      style: { padding: 20, color: 'var(--text-muted)', fontSize: 13 } as React.CSSProperties,
    }, 'Click a node to see details');
  }

  const st = status?.status || 'pending';
  const statusColor = STATUS_COLORS[st] || '#8c959f';

  const openOutput = (p: string) => {
    fetch('/api/open-output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    }).catch(() => {});
  };

  return React.createElement('div', { style: { padding: 20 } as React.CSSProperties },
    React.createElement('div', { style: { color: 'var(--text-primary)', fontSize: 15, fontWeight: 700, marginBottom: 4 } as React.CSSProperties }, stepName),
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 } as React.CSSProperties },
      React.createElement('span', {
        className: 'cliflow-status-dot',
        style: { background: statusColor } as React.CSSProperties,
      }),
      React.createElement('span', { style: { color: statusColor, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 } as React.CSSProperties }, STATUS_LABELS[st] || st),
    ),

    step?.description && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Description'),
      React.createElement('div', { style: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 } as React.CSSProperties }, step.description),
    ),

    step?.adapter && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Adapter'),
      React.createElement('code', { style: { color: 'var(--color-foreach)', fontSize: 12, background: 'var(--bg-chip)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' } as React.CSSProperties }, step.adapter),
    ),

    step?.workflow && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Nested Workflow'),
      React.createElement('code', { style: { color: 'var(--color-foreach)', fontSize: 12, background: 'var(--bg-chip)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' } as React.CSSProperties }, step.workflow),
    ),

    step?.foreach && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Foreach'),
      React.createElement('code', { style: { color: 'var(--color-interacting)', fontSize: 12, background: 'var(--bg-chip)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' } as React.CSSProperties }, step.foreach),
    ),

    status?.durationMs !== undefined && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Duration'),
      React.createElement('div', { style: { color: 'var(--text-primary)', fontSize: 14 } as React.CSSProperties }, `${(status.durationMs / 1000).toFixed(1)}s`),
    ),

    status?.error && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--color-error)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Error'),
      React.createElement('div', { style: { color: 'var(--color-error)', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word' } as React.CSSProperties }, status.error),
    ),

    step?.depends_on && step.depends_on.length > 0 && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Depends On'),
      React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } as React.CSSProperties },
        step.depends_on.map((dep: string) =>
          React.createElement('span', { key: dep, style: { color: 'var(--text-secondary)', fontSize: 11, background: 'var(--bg-chip)', padding: '2px 6px', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)' } as React.CSSProperties }, dep)
        ),
      ),
    ),

    status?.foreachProgress && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 } as React.CSSProperties }, 'Foreach Progress'),
      React.createElement('div', { style: { color: 'var(--text-primary)', fontSize: 14 } as React.CSSProperties },
        `${status.foreachProgress.completed}/${status.foreachProgress.total}`
        + (status.foreachProgress.failed > 0 ? ` (${status.foreachProgress.failed} failed)` : ''),
      ),
    ),

    status?.outputPaths && status.outputPaths.length > 0 && React.createElement('div', { style: { marginBottom: 14 } as React.CSSProperties },
      React.createElement('div', { style: { color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 } as React.CSSProperties }, 'Output Files'),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } as React.CSSProperties },
        status.outputPaths.map((p, i) =>
          React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 8 } as React.CSSProperties },
            React.createElement('code', {
              style: {
                flex: 1, color: 'var(--text-secondary)', fontSize: 11,
                background: 'var(--bg-chip)', padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              } as React.CSSProperties,
              title: p,
            }, basename(p)),
            React.createElement('button', {
              onClick: () => openOutput(p),
              title: `Reveal in file manager`,
              style: {
                padding: '4px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                border: '1px solid var(--border-color)', background: 'var(--bg-card)',
                color: 'var(--text-secondary)', fontSize: 11, fontWeight: 600,
              } as React.CSSProperties,
            }, '📂 Open'),
          ),
        ),
      ),
    ),
  );
}

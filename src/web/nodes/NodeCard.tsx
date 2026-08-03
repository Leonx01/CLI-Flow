/**
 * NodeCard — shared base card for all workflow node types.
 *
 * Layout:
 *   ┌────────────────────────────────────────┐
 *   │ ● tech-radar               12.3s      │  header: status dot + label + duration chip
 *   │   ⛁ radar-report                     │  body:   description + type badge (children)
 *   │   ⚑ output/radar.md                  │  footer: foreach progress bar / output links / error
 *   └────────────────────────────────────────┘
 *
 * Status is expressed as a colored dot + left edge accent, not the whole
 * border. Style uses CSS variables from ../style.css.
 */

import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { FlowNodeData } from '../types.js';
import { STATUS_COLORS } from './status.js';
import { openOutput } from './open-output.js';

export interface NodeCardProps {
  data: FlowNodeData;
  /** Extra badge/body content rendered under the description (e.g. adapter chip). */
  badge?: React.ReactNode;
  /** True for nested-workflow nodes → dashed border. */
  dashed?: boolean;
}

/** Chip with a light status-colored background. */
export function Chip({ children, color }: { children?: React.ReactNode; color?: string }) {
  return React.createElement('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '1px 6px',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--bg-chip)',
      color: color || 'var(--text-secondary)',
      fontSize: 10,
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    } as React.CSSProperties,
  }, children);
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export default function NodeCard({ data, badge, dashed }: NodeCardProps) {
  const color = STATUS_COLORS[data.status] || STATUS_COLORS.pending;
  const isRunning = data.status === 'running';
  const isInteracting = data.status === 'interacting';
  const isDone = data.status === 'completed';
  const isRetrying = data.status === 'retrying';

  const fp = data.foreachProgress;

  // Container: white card, 1px border, soft shadow; running/interacting get a
  // subtle colored glow instead of a hexagon clipPath.
  const containerStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    border: `1px solid var(--border-card)`,
    borderLeft: `3px solid ${color}`,
    borderRadius: 'var(--radius-md)',
    padding: '8px 10px',
    minWidth: 170,
    maxWidth: 240,
    opacity: data.status === 'blocked' ? 0.55 : data.status === 'pending' ? 0.8 : 1,
    boxShadow: isInteracting ? 'var(--shadow-interact-glow)'
      : isRunning || isRetrying ? 'var(--shadow-running-glow)'
      : 'var(--shadow-card)',
    transition: 'box-shadow 0.25s, opacity 0.25s',
    cursor: 'pointer',
  };
  if (dashed) containerStyle.borderTopStyle = containerStyle.borderRightStyle = containerStyle.borderBottomStyle = 'dashed';

  return React.createElement('div', { style: containerStyle },
    React.createElement(Handle, { type: 'target', position: Position.Left, style: { background: '#c3c8cf' } }),

    // ── Header: status dot + label + duration chip ──
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 } as React.CSSProperties },
      React.createElement('span', {
        className: 'cliflow-status-dot',
        style: {
          background: color,
          animation: isRunning || isInteracting ? 'cliflow-pulse 1.5s infinite' : 'none',
        } as React.CSSProperties,
      }),
      React.createElement('span', {
        style: {
          color: 'var(--text-primary)',
          fontSize: 11,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: 1,
        } as React.CSSProperties,
      }, data.label),
      data.durationMs !== undefined && isDone
        ? React.createElement('span', {
            style: {
              color: 'var(--text-muted)',
              fontSize: 9,
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap',
            } as React.CSSProperties,
          }, `${(data.durationMs / 1000).toFixed(1)}s`)
        : null,
    ),

    // ── Body: description + type badge ──
    (data.description || badge)
      ? React.createElement('div', { style: { marginBottom: 4 } as React.CSSProperties },
          data.description
            ? React.createElement('div', {
                style: {
                  color: 'var(--text-secondary)',
                  fontSize: 10,
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                } as React.CSSProperties,
              }, data.description)
            : null,
          badge
            ? React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 } as React.CSSProperties }, badge)
            : null,
        )
      : null,

    // ── Footer: foreach progress / output links / error ──
    (fp || (data.outputPaths && data.outputPaths.length > 0) || data.error)
      ? React.createElement('div', { style: { marginTop: 5, display: 'flex', flexDirection: 'column', gap: 4 } as React.CSSProperties },

          // foreach progress bar
          fp ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } as React.CSSProperties },
            React.createElement('div', {
              style: {
                flex: 1,
                height: 4,
                borderRadius: 2,
                background: '#e9ecef',
                overflow: 'hidden',
              } as React.CSSProperties,
            },
              React.createElement('div', {
                style: {
                  width: `${fp.total > 0 ? Math.round((fp.completed / fp.total) * 100) : 0}%`,
                  height: '100%',
                  background: fp.failed > 0 ? 'var(--color-error)' : 'var(--color-foreach)',
                  borderRadius: 2,
                  transition: 'width 0.3s',
                } as React.CSSProperties,
              }),
            ),
            React.createElement('span', {
              style: {
                color: fp.failed > 0 ? 'var(--color-error)' : 'var(--color-foreach)',
                fontSize: 9,
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              } as React.CSSProperties,
            }, `${fp.completed}/${fp.total}${fp.failed > 0 ? ` · ${fp.failed}✗` : ''}`),
          ) : null,

          // output file links
          data.outputPaths && data.outputPaths.length > 0
            ? data.outputPaths.map((p, i) =>
                React.createElement('span', {
                  key: i,
                  onClick: (e: React.MouseEvent) => {
                    e.stopPropagation();
                    openOutput(p);
                  },
                  title: p,
                  style: {
                    color: 'var(--color-foreach)',
                    fontSize: 9,
                    fontFamily: 'var(--font-mono)',
                    cursor: 'pointer',
                    textDecoration: 'none',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  } as React.CSSProperties,
                }, `⚑ ${basename(p)}`),
              )
            : null,

          // error chip
          data.error
            ? React.createElement('div', {
                style: {
                  color: 'var(--color-error)',
                  fontSize: 9,
                  lineHeight: 1.3,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                } as React.CSSProperties,
              }, `✗ ${data.error.slice(0, 90)}`)
            : null,
        )
      : null,

    React.createElement(Handle, { type: 'source', position: Position.Right, style: { background: '#c3c8cf' } }),
  );
}

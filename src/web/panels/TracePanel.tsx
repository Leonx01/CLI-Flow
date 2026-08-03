import React, { useRef, useEffect } from 'react';

interface TraceEntry {
  ts: number;
  type: string;
  stepName?: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

interface TracePanelProps {
  entries: TraceEntry[];
}

const LEVEL_COLORS: Record<string, string> = {
  info: '#8c959f',
  warn: '#bf8700',
  error: '#cf222e',
};

const LEVEL_ICONS: Record<string, string> = {
  info: '·',
  warn: '⚠',
  error: '✗',
};

export default function TracePanel({ entries }: TracePanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  const remaining = entries.length > 0 ? entries.slice(-50) : entries;

  return React.createElement('div', {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border-color)',
    } as React.CSSProperties,
  },
    React.createElement('div', {
      style: {
        padding: '6px 12px',
        color: 'var(--text-muted)',
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 1,
        borderBottom: '1px solid var(--border-color)',
      } as React.CSSProperties,
    }, `Trace (${entries.length} events)`),
    React.createElement('div', {
      style: {
        flex: 1,
        overflow: 'auto',
        padding: '4px 0',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
      } as React.CSSProperties,
    },
      entries.length === 0
        ? React.createElement('div', {
            style: { padding: '12px 16px', color: 'var(--text-muted)', fontStyle: 'italic' } as React.CSSProperties,
          }, 'No events yet. Click ▶ Run to start.')
        : remaining.map((entry, i) =>
            React.createElement('div', {
              key: i,
              style: {
                display: 'flex',
                gap: 8,
                padding: '2px 12px',
                color: LEVEL_COLORS[entry.level] || 'var(--text-muted)',
                borderLeft: entry.level === 'error' ? '2px solid var(--color-error)' : '2px solid transparent',
                background: entry.level === 'error' ? 'rgba(207, 34, 46, 0.06)' : 'transparent',
              } as React.CSSProperties,
            },
              React.createElement('span', { style: { color: 'var(--text-muted)', minWidth: 70 } as React.CSSProperties },
                new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false }),
              ),
              React.createElement('span', { style: { color: LEVEL_COLORS[entry.level], fontWeight: 600, minWidth: 14 } as React.CSSProperties },
                LEVEL_ICONS[entry.level],
              ),
              React.createElement('span', { style: { color: 'var(--color-foreach)', minWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as React.CSSProperties },
                entry.stepName || '',
              ),
              React.createElement('span', { style: { flex: 1, wordBreak: 'break-word' } as React.CSSProperties },
                entry.message,
              ),
            ),
          ),
      React.createElement('div', { ref: bottomRef }),
    ),
  );
}

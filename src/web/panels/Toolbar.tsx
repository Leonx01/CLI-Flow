import React from 'react';

interface ToolbarProps {
  workflowName: string;
  status: string;
  connected: boolean;
  onRun: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Ready',
  running: 'Running…',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
};

const STATUS_COLORS: Record<string, string> = {
  idle: '#8c959f',
  running: '#d97706',
  completed: '#2da44e',
  failed: '#cf222e',
  paused: '#bf8700',
};

export default function Toolbar({ workflowName, status, connected, onRun }: ToolbarProps) {
  const isRunning = status === 'running';

  return React.createElement('div', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 16px', background: 'var(--bg-toolbar)',
      borderBottom: '1px solid var(--border-color)',
      userSelect: 'none',
    } as React.CSSProperties,
  },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } as React.CSSProperties },
      React.createElement('span', { style: { fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' } as React.CSSProperties }, 'CLI-Flow'),
      React.createElement('span', { style: { color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-mono)' } as React.CSSProperties }, workflowName),
    ),
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } as React.CSSProperties },
      React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } as React.CSSProperties },
        React.createElement('span', {
          className: 'cliflow-status-dot',
          style: { background: connected ? '#2da44e' : '#cf222e' } as React.CSSProperties,
        }),
        React.createElement('span', { style: { color: 'var(--text-muted)', fontSize: 12 } as React.CSSProperties }, connected ? 'Connected' : 'Disconnected'),
      ),
      React.createElement('span', {
        style: {
          color: STATUS_COLORS[status] || 'var(--text-muted)',
          fontSize: 12,
          fontWeight: 600,
          background: 'var(--bg-chip)',
          padding: '2px 8px',
          borderRadius: 'var(--radius-sm)',
        } as React.CSSProperties,
      }, STATUS_LABELS[status] || status),
      React.createElement('button', {
        onClick: onRun,
        disabled: isRunning,
        style: {
          padding: '5px 16px', borderRadius: 6, border: 'none', cursor: isRunning ? 'not-allowed' : 'pointer',
          background: isRunning ? 'var(--bg-chip)' : '#2da44e', color: isRunning ? 'var(--text-muted)' : '#fff',
          fontSize: 13, fontWeight: 600, transition: 'background 0.15s, transform 0.1s',
        } as React.CSSProperties,
      }, isRunning ? 'Running…' : '▶ Run'),
    ),
  );
}

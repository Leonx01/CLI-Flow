import React from 'react';

interface ToolbarProps {
  workflowName: string;
  status: string;
  connected: boolean;
  onRun: () => void;
  autoRun: boolean;
  onToggleAutoRun: () => void;
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

export default function Toolbar({ workflowName, status, connected, onRun, autoRun, onToggleAutoRun }: ToolbarProps) {
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
        onClick: onToggleAutoRun,
        title: autoRun ? 'Auto-run ON: starts the workflow when the page loads' : 'Auto-run OFF: click ▶ Run to start',
        style: {
          padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
          border: `1px solid ${autoRun ? '#2da44e' : 'var(--border-color)'}`,
          background: autoRun ? 'rgba(45, 164, 78, 0.1)' : 'var(--bg-card)',
          color: autoRun ? '#1a7f37' : 'var(--text-muted)',
          fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
        } as React.CSSProperties,
      }, autoRun ? '⟳ Auto-run ON' : '⟳ Auto-run OFF'),
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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Canvas from './Canvas.js';
import Toolbar from './panels/Toolbar.js';
import InteractPanel from './panels/InteractPanel.js';
import DetailPanel from './panels/DetailPanel.js';
import TracePanel from './panels/TracePanel.js';
import type { WorkflowDefinition } from '../schema/types.js';
import type { WSMessage, StepUIState } from './types.js';
import { extractOutputPaths } from '../util/output-paths.js';

interface TraceEntry {
  ts: number;
  type: string;
  stepName?: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

function addTrace(prev: TraceEntry[], entry: TraceEntry): TraceEntry[] {
  return [...prev.slice(-199), entry]; // keep max 200
}

export default function App() {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [stepStatus, setStepStatus] = useState<Record<string, StepUIState>>({});
  const [workflowStatus, setWorkflowStatus] = useState<string>('idle');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [pendingInteract, setPendingInteract] = useState<{
    stepName: string;
    spec: { type: string; message: string; options?: { label: string; value: unknown }[]; default?: string };
  } | null>(null);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [showTrace, setShowTrace] = useState(true);
  const [autoRun, setAutoRun] = useState<boolean>(() => {
    try { return localStorage.getItem('cliflow:autoRun') === '1'; } catch { return false; }
  });
  const autoRunChecked = useRef(false);

  // Load definition from server
  useEffect(() => {
    fetch('/api/definition')
      .then(r => r.json())
      .then(def => setDefinition(def))
      .catch(() => {});
  }, []);

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

    socket.onopen = () => {
      setConnected(true);
      setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'connect', message: 'WebSocket connected', level: 'info' }));
    };
    socket.onclose = () => {
      setConnected(false);
      setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'connect', message: 'WebSocket disconnected', level: 'warn' }));
    };

    socket.onmessage = (event) => {
      const msg: WSMessage = JSON.parse(event.data);

      switch (msg.type) {
        case 'workflow:start':
          setWorkflowStatus('running');
          setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'workflow', message: `Started "${msg.workflow}" (${msg.totalSteps} steps)`, level: 'info' }));
          break;

        case 'step:start':
          if (msg.stepName) {
            setStepStatus(prev => ({
              ...prev,
              [msg.stepName!]: { stepName: msg.stepName!, status: 'running', startedAt: msg.startedAt },
            }));
            setPendingInteract(null);
            setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'step', stepName: msg.stepName, message: `Started`, level: 'info' }));
          }
          break;

        case 'step:end':
          if (msg.stepName) {
            const isError = msg.status === 'failed';
            const paths = extractOutputPaths(msg.output?.value);
            setStepStatus(prev => ({
              ...prev,
              [msg.stepName!]: {
                ...prev[msg.stepName!],
                stepName: msg.stepName!,
                status: msg.status as StepUIState['status'],
                durationMs: msg.durationMs,
                error: msg.error,
                skipReason: msg.skipReason,
                outputPaths: paths,
                foreachErrors: msg.foreachErrors,
              },
            }));
            const dur = msg.durationMs ? ` (${(msg.durationMs / 1000).toFixed(1)}s)` : '';
            setTrace(prev => addTrace(prev, {
              ts: Date.now(), type: 'step', stepName: msg.stepName,
              message: isError ? `FAILED: ${msg.error || 'unknown error'}` : msg.status === 'skipped' ? `Skipped: ${msg.skipReason || ''}` : `Completed${dur}`,
              level: isError ? 'error' : msg.status === 'skipped' ? 'warn' : 'info',
            }));
          }
          break;

        case 'step:skipped':
          if (msg.stepName) {
            setStepStatus(prev => ({
              ...prev,
              [msg.stepName!]: { stepName: msg.stepName!, status: 'skipped', skipReason: msg.reason },
            }));
            setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'step', stepName: msg.stepName, message: `Skipped: ${msg.reason}`, level: 'warn' }));
          }
          break;

        case 'step:retry':
          if (msg.stepName) {
            setStepStatus(prev => ({
              ...prev,
              [msg.stepName!]: { ...prev[msg.stepName!], stepName: msg.stepName!, status: 'retrying', retry: { current: msg.attempt || 0, max: msg.maxRetries || 0 }, error: msg.error },
            }));
            setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'step', stepName: msg.stepName, message: `Retry ${msg.attempt}/${msg.maxRetries}: ${msg.error}`, level: 'warn' }));
          }
          break;

        case 'step:foreach':
          if (msg.stepName && msg.foreachProgress) {
            setStepStatus(prev => ({
              ...prev,
              [msg.stepName!]: { ...prev[msg.stepName!], foreachProgress: msg.foreachProgress },
            }));
          }
          break;

        case 'interact:pending':
          if (msg.stepName && msg.spec) {
            setPendingInteract({ stepName: msg.stepName, spec: msg.spec as { type: string; message: string; options?: { label: string; value: unknown }[] } });
            setStepStatus(prev => ({
              ...prev,
              [msg.stepName!]: { ...prev[msg.stepName!], stepName: msg.stepName!, status: 'interacting' },
            }));
            setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'interact', stepName: msg.stepName, message: `Waiting: ${msg.spec?.message}`, level: 'info' }));
          }
          break;

        case 'interact:resolved':
          setPendingInteract(null);
          setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'interact', stepName: msg.stepName, message: 'Resolved', level: 'info' }));
          break;

        case 'workflow:end':
          setWorkflowStatus(msg.status === 'completed' ? 'completed' : msg.status === 'paused' ? 'paused' : 'failed');
          setTrace(prev => addTrace(prev, {
            ts: Date.now(), type: 'workflow',
            message: `Workflow ${msg.status?.toUpperCase()}`,
            level: msg.status === 'completed' ? 'info' : msg.status === 'failed' ? 'error' : 'warn',
          }));
          break;

        case 'error':
          setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'error', message: msg.message || 'Unknown error', level: 'error' }));
          break;
      }
    };

    setWs(socket);
    return () => socket.close();
  }, []);

  const handleRun = useCallback(() => {
    if (!ws) return;
    setStepStatus({});
    setTrace([]);
    setWorkflowStatus('running');
    setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'workflow', message: '▶ Run clicked', level: 'info' }));
    fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  }, [ws]);

  // Auto-run: with the toggle ON, start the workflow once per server process.
  // /api/state.runStarted guards against re-running after a page reload.
  useEffect(() => {
    if (!autoRun || !ws || autoRunChecked.current) return;
    autoRunChecked.current = true;
    fetch('/api/state')
      .then(r => r.json())
      .then((s: { runStarted: boolean }) => {
        if (!s.runStarted) {
          setTrace(prev => addTrace(prev, { ts: Date.now(), type: 'workflow', message: '⟳ Auto-run: starting workflow', level: 'info' }));
          handleRun();
        }
      })
      .catch(() => {});
  }, [autoRun, ws, handleRun]);

  const handleToggleAutoRun = useCallback(() => {
    setAutoRun(prev => {
      const next = !prev;
      try { localStorage.setItem('cliflow:autoRun', next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const handleInteractSubmit = useCallback((answer: unknown) => {
    fetch('/api/interact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) });
    setPendingInteract(null);
  }, []);

  if (!definition) {
    return React.createElement('div', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 18, color: 'var(--text-muted)', background: 'var(--bg-page)' }
    }, 'Loading workflow definition...');
  }

  const traceHeight = showTrace ? 200 : 28;

  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-page)' } },
    React.createElement(Toolbar, {
      workflowName: definition.name,
      status: workflowStatus,
      connected,
      onRun: handleRun,
      autoRun,
      onToggleAutoRun: handleToggleAutoRun,
    }),
    React.createElement('div', { style: { display: 'flex', flex: 1, overflow: 'hidden' } },
      React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { flex: 1 } },
          React.createElement(Canvas, { definition, stepStatus, selectedNode, onNodeSelect: setSelectedNode }),
        ),
        // Trace panel at bottom
        React.createElement('div', { style: { height: traceHeight, borderTop: '1px solid var(--border-color)', transition: 'height 0.2s' } },
          React.createElement(TracePanel, { entries: trace }),
        ),
        // Toggle button
        React.createElement('button', {
          onClick: () => setShowTrace(!showTrace),
          style: {
            position: 'absolute', bottom: showTrace ? traceHeight - 2 : 0, right: 332, zIndex: 10,
            background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderBottom: 'none',
            color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer', padding: '2px 8px', borderRadius: '4px 4px 0 0',
          } as React.CSSProperties,
        }, showTrace ? '▼ Trace' : '▲ Trace'),
      ),
      React.createElement('div', { style: { width: 320, borderLeft: '1px solid var(--border-color)', overflow: 'auto', background: 'var(--bg-panel)' } },
        pendingInteract
          ? React.createElement(InteractPanel, { interact: pendingInteract, onSubmit: handleInteractSubmit })
          : React.createElement(DetailPanel, {
              stepName: selectedNode,
              step: selectedNode ? definition.steps[selectedNode] : undefined,
              status: selectedNode ? stepStatus[selectedNode] : undefined,
            }),
      ),
    ),
  );
}

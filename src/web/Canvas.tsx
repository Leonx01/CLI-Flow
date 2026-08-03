import React, { useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { workflowToFlow } from './layout.js';
import { nodeTypes } from './nodes/index.js';
import type { WorkflowDefinition } from '../schema/types.js';
import type { StepUIState } from './types.js';

interface CanvasProps {
  definition: WorkflowDefinition;
  stepStatus: Record<string, StepUIState>;
  selectedNode: string | null;
  onNodeSelect: (id: string | null) => void;
}

export default function Canvas({ definition, stepStatus, selectedNode, onNodeSelect }: CanvasProps) {
  const { nodes, edges } = useMemo(() => workflowToFlow(definition), [definition]);

  const styledNodes = useMemo(() =>
    nodes.map(n => {
      const s = stepStatus[n.id];
      return {
        ...n,
        data: {
          ...n.data,
          status: s?.status || 'pending',
          durationMs: s?.durationMs,
          error: s?.error,
          foreachProgress: s?.foreachProgress,
          foreachErrors: s?.foreachErrors,
          outputPaths: s?.outputPaths,
        },
      };
    }),
    [nodes, stepStatus]
  );

  const styledEdges = useMemo(() =>
    edges.map(e => {
      const targetStatus = stepStatus[e.target]?.status;
      const isActive = targetStatus === 'running' || targetStatus === 'retrying';
      return { ...e, animated: isActive, style: { ...e.style, stroke: isActive ? '#2da44e' : '#c3c8cf' } };
    }),
    [edges, stepStatus]
  );

  return React.createElement('div', { style: { width: '100%', height: '100%', background: 'var(--bg-page)' } },
    React.createElement(ReactFlow, {
      nodes: styledNodes,
      edges: styledEdges,
      nodeTypes,
      fitView: true,
      onNodeClick: (_e, node) => onNodeSelect(node.id),
      onPaneClick: () => onNodeSelect(null),
      defaultEdgeOptions: { type: 'smoothstep' },
    },
      React.createElement(Controls, {
        style: { background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' },
        showInteractive: false,
      }),
      React.createElement(MiniMap, {
        style: { background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 },
        nodeColor: (n) => (n.data?.status === 'completed' ? '#2da44e' : n.data?.status === 'running' ? '#d97706' : '#d8dbe0'),
        nodeStrokeColor: '#fff',
      }),
      React.createElement(Background, { variant: BackgroundVariant.Dots, gap: 22, size: 1.5, color: '#d3d7de' }),
    ),
  );
}

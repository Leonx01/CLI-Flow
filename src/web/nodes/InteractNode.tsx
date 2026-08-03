import React from 'react';
import NodeCard, { Chip } from './NodeCard.js';
import type { FlowNodeData } from '../types.js';

export default function InteractNode({ data }: { data: FlowNodeData }) {
  const isInteracting = data.status === 'interacting';

  const badge = React.createElement(
    Chip,
    { color: isInteracting ? 'var(--color-interacting)' : 'var(--color-interacting)' },
    isInteracting ? '◉ waiting for input' : 'ⓘ interact',
  );

  return React.createElement(NodeCard, { data, badge });
}

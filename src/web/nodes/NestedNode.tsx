import React from 'react';
import NodeCard, { Chip } from './NodeCard.js';
import type { FlowNodeData } from '../types.js';

export default function NestedNode({ data }: { data: FlowNodeData }) {
  const badge = data.workflow
    ? React.createElement(Chip, { color: 'var(--text-secondary)' }, `▤ ${data.workflow}`)
    : null;

  return React.createElement(NodeCard, { data, badge, dashed: true });
}

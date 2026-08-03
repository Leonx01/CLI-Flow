import React from 'react';
import NodeCard, { Chip } from './NodeCard.js';
import type { FlowNodeData } from '../types.js';

export default function AdapterNode({ data }: { data: FlowNodeData }) {
  const badge = data.adapter
    ? React.createElement(Chip, { color: 'var(--color-foreach)' }, `⛁ ${data.adapter}`)
    : null;

  return React.createElement(NodeCard, { data, badge });
}

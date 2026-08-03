import dagre from 'dagre';
import type { WorkflowDefinition } from '../schema/types.js';
import type { FlowNodeData } from './types.js';

export function workflowToFlow(definition: WorkflowDefinition) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  const steps = Object.entries(definition.steps);
  if (steps.length === 0) return { nodes: [], edges: [] };

  // Add nodes to dagre
  steps.forEach(([name, step]) => {
    const isInteract = !!step.interact;
    const isWorkflow = step.type === 'workflow' || !!step.workflow;
    const width = isInteract ? 200 : isWorkflow ? 210 : 180;
    g.setNode(name, { width, height: 70 });
  });

  // Add edges
  steps.forEach(([name, step]) => {
    (step.depends_on || []).forEach((dep: string) => {
      if (g.hasNode(dep)) g.setEdge(dep, name);
    });
  });

  dagre.layout(g);

  const nodes = steps.map(([name, step]) => {
    const isInteract = !!step.interact;
    const isWorkflow = step.type === 'workflow' || !!step.workflow;
    const nodeType = isInteract ? 'interact' : isWorkflow ? 'nested' : 'adapter';

    const data: FlowNodeData = {
      label: name,
      status: 'pending',
      description: step.description,
      adapter: step.adapter,
      workflow: step.workflow,
      foreach: step.foreach,
    };

    return {
      id: name,
      type: nodeType,
      position: {
        x: g.node(name).x - (isInteract ? 100 : isWorkflow ? 105 : 90),
        y: g.node(name).y - 35,
      },
      data,
    };
  });

  const edges = steps.flatMap(([name, step]) =>
    (step.depends_on || [])
      .filter((dep: string) => g.hasNode(dep))
      .map((dep: string) => ({
        id: `${dep}|${name}`,
        source: dep,
        target: name,
        type: 'smoothstep' as const,
        animated: false,
        style: { stroke: '#555', strokeWidth: 2 },
      }))
  );

  return { nodes, edges };
}

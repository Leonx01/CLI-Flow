import type { WorkflowNode, FlatRow } from './types.js';
import { deriveStatus } from './status.js';

// ---------------------------------------------------------------------------
// Flatten the recursive tree into an ordered list of visible rows, computing
// the ASCII tree-line prefix for arbitrary depth.
//
//   ├─  middle child
//   └─  last child
//   │   vertical continuation of an ancestor branch that is not yet finished
//   (spaces) when the ancestor branch is finished
// ---------------------------------------------------------------------------

const T_BRANCH = '├─ ';
const L_BRANCH = '└─ ';
const V_LINE = '│  ';
const SPACE = '   ';

/**
 * Flatten the tree into an array of FlatRow suitable for rendering.
 *
 * @param root - The root WorkflowNode
 * @param foreachExpandLevels - Optional map of path → expand level overrides
 *                              (if not supplied, reads from node.foreachExpandLevel)
 */
export function flatten(root: WorkflowNode, _foreachExpandLevels?: Map<string, 0 | 1 | 2>): FlatRow[] {
  const rows: FlatRow[] = [];

  const walk = (
    node: WorkflowNode,
    depth: number,
    prefix: string,
    connector: string,
    isLast: boolean,
    pathStr: string,
  ) => {
    rows.push({ node, prefix, connector, path: pathStr });

    const children = node.children;
    if (!children || children.length === 0) return;

    // If collapsed, hide all children
    if (node.collapsed) return;

    // Foreach node filtering based on expand level
    const isForeach = node.meta?.foreachProgress !== undefined || node.meta?.foreachSource !== undefined;
    const expandLevel = node.foreachExpandLevel ?? 0;

    let visibleChildren = children;
    if (isForeach) {
      if (expandLevel === 0) {
        // Level 0: no children shown (aggregated only)
        return;
      } else if (expandLevel === 1) {
        // Level 1: show children that actually executed (hide pending/skipped)
        visibleChildren = children.filter((child) => {
          const st = deriveStatus(child);
          return st !== 'pending' && st !== 'skipped';
        });
        if (visibleChildren.length === 0) return;
      }
      // Level 2: show all children (default)
    }

    // Extend the prefix for this node's children
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? SPACE : V_LINE);

    visibleChildren.forEach((child, i) => {
      const childIsLast = i === visibleChildren.length - 1;
      const childPath = pathStr ? `${pathStr}/${child.id}` : child.id;
      walk(
        child,
        depth + 1,
        childPrefix,
        childIsLast ? L_BRANCH : T_BRANCH,
        childIsLast,
        childPath,
      );
    });
  };

  walk(root, 0, '', '', true, '');
  return rows;
}

/**
 * Toggle the `collapsed` flag on the node at the given path string.
 * Returns a new tree (immutable update via structuredClone).
 */
export function toggleCollapsed(root: WorkflowNode, path: string): WorkflowNode {
  const clone: WorkflowNode = structuredClone(root);
  const node = findNodeByPath(clone, path);
  if (node && node.children && node.children.length > 0) {
    node.collapsed = !node.collapsed;
  }
  return clone;
}

/**
 * Cycle the foreach expand level for a node at path.
 * direction 'expand': 0 → 1 → 2
 * direction 'collapse': 2 → 1 → 0
 * Returns a new tree.
 */
export function cycleForeachExpand(
  root: WorkflowNode,
  path: string,
  direction: 'expand' | 'collapse',
): WorkflowNode {
  const clone: WorkflowNode = structuredClone(root);
  const node = findNodeByPath(clone, path);
  if (!node) return clone;

  const current = node.foreachExpandLevel ?? 0;
  if (direction === 'expand') {
    node.foreachExpandLevel = Math.min(2, current + 1) as 0 | 1 | 2;
  } else {
    node.foreachExpandLevel = Math.max(0, current - 1) as 0 | 1 | 2;
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findNodeByPath(root: WorkflowNode, path: string): WorkflowNode | undefined {
  if (!path) return root;
  const segments = path.split('/');
  let current: WorkflowNode | undefined = root;
  for (const seg of segments) {
    if (!current?.children) return undefined;
    current = current.children.find((c) => c.id === seg);
    if (!current) return undefined;
  }
  return current;
}

// Core data model for the nested workflow TUI.
// Extended from workflow-tui prototype with additional states and metadata.

import type { ResolvedInteractSpec } from '../../schema/types.js';

export type Status =
  | 'done'
  | 'running'
  | 'pending'
  | 'blocked'
  | 'failed'
  | 'skipped'
  | 'retrying'
  | 'interacting';

export interface NodeMeta {
  durationMs?: number;
  startedAt?: number;
  tokens?: number;
  retry?: { current: number; max: number };
  foreachProgress?: { completed: number; total: number; failed: number };
  foreachErrors?: string[];
  /** 所属 foreach 父节点的迭代总数 */
  iterationTotal?: number;
  /** 所属 foreach 父节点已完成的迭代数 */
  iterationCompleted?: number;
  interactMessage?: string;
  error?: string;
  /** 适配器名称 */
  adapter?: string;
  /** 子workflow文件名 */
  workflowFile?: string;
  /** foreach源名 */
  foreachSource?: string;
  /** 超时配置(ms) */
  timeout?: number;
  /** 错误策略 */
  onError?: string;
  /** 跳过原因 */
  skipReason?: 'on_error_skip' | 'missing_var' | 'condition_false' | 'dependency_failed' | 'auth_skipped' | 'interact_pending';
  /** 步骤输出的文件路径 */
  outputPaths?: string[];
  /** 依赖步骤 */
  dependsOn?: string[];
  /** 带序号的依赖步骤显示文本，如 ['#5 rank-authors', '#4 search-papers'] */
  dependsOnDisplay?: string[];
}

export interface WorkflowNode {
  id: string;
  label: string;
  /** Display order based on YAML step sequence, e.g. "#1", "#2.1" */
  order?: string;
  /**
   * "workflow" = container node with children, rendered with a +/- expand
   * toggle and an aggregated progress count.
   * "step" = leaf node, rendered with a status icon only.
   */
  type: 'workflow' | 'step';
  /**
   * Explicit status. For leaf steps this is the source of truth.
   * For workflow nodes it is IGNORED and derived from children.
   */
  status?: Status;
  children?: WorkflowNode[];
  meta?: NodeMeta;
  /** Human-readable dependency note, e.g. "清洗与转换". */
  blockedBy?: string;
  /** UI state: whether a workflow node is collapsed. */
  collapsed?: boolean;
  /** foreach 三级展开状态: 0=折叠, 1=摘要, 2=完全展开 */
  foreachExpandLevel?: 0 | 1 | 2;
}

/** Flattened row for rendering the tree in a terminal list. */
export interface FlatRow {
  path: string;
  prefix: string;
  connector: string;
  node: WorkflowNode;
}

/** Pending interactive request from workflow engine. */
export interface InteractRequest {
  id: string;
  stepName: string;
  tabLabel?: string;
  spec: ResolvedInteractSpec;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

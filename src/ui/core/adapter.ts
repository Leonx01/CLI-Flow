/**
 * InkAdapter — bridges flat WorkflowCallbacks events into a recursive
 * WorkflowNode tree consumed by Ink React components.
 */

import type {
  WorkflowCallbacks,
  StepStartEvent,
  StepEndEvent,
  StepRetryEvent,
  ForeachProgressEvent,
  ResolvedInteractSpec,
  TraceEvent,
} from '../../schema/types.js';
import type { WorkflowNode, Status, InteractRequest, NodeMeta } from './types.js';

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Recursively find a node by path segments (e.g. ['a','b','c']). */
function findNode(root: WorkflowNode, path: string[]): WorkflowNode | undefined {
  let current: WorkflowNode | undefined = root;
  for (const segment of path) {
    if (!current?.children) return undefined;
    current = current.children.find((c) => c.id === segment);
    if (!current) return undefined;
  }
  return current;
}

/** Find or lazily create the chain of nodes for the given path. */
function ensureNode(root: WorkflowNode, path: string[]): WorkflowNode {
  let current = root;
  for (const segment of path) {
    if (!current.children) current.children = [];
    let child = current.children.find((c) => c.id === segment);
    if (!child) {
      const childIndex = current.children.length + 1;
      const parentOrder = current.order;
      const order = parentOrder
        ? `${parentOrder}.${childIndex}`
        : `#${childIndex}`;
      child = {
        id: segment,
        label: segment,
        order,
        type: 'workflow',
        status: 'running',
        children: [],
      };
      current.children.push(child);
    }
    current = child;
  }
  return current;
}

/** Deep clone a WorkflowNode tree. */
function cloneTree(node: WorkflowNode): WorkflowNode {
  return structuredClone(node);
}

// ---------------------------------------------------------------------------
// InkAdapter
// ---------------------------------------------------------------------------

let interactCounter = 0;

export class InkAdapter {
  private root: WorkflowNode;
  private listeners: Set<(root: WorkflowNode) => void> = new Set();
  private interactListeners: Set<(reqs: InteractRequest[]) => void> = new Set();
  private pendingInteracts: Map<string, InteractRequest> = new Map();
  private interactStepPaths: Map<string, string[]> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  public startedAt: number = Date.now();

  private endResolve: (() => void) | null = null;
  private endPromise: Promise<void>;

  private userExitResolve: (() => void) | null = null;
  private userExitPromise: Promise<void>;

  constructor(
    def: { name: string; steps: Record<string, any> },
    private onTraceEvent?: (stepName: string, event: TraceEvent) => void,
  ) {
    const children: WorkflowNode[] = Object.entries(def.steps).map(([key, stepDef], index) => ({
      id: key,
      label: stepDef.description || key,
      order: `#${index + 1}`,
      type: stepDef.workflow ? 'workflow' as const : 'step' as const,
      status: 'pending' as Status,
      children: [],
      ...(stepDef.workflow || stepDef.foreach ? { foreachExpandLevel: 1 as const } : {}),
      meta: {
        adapter: stepDef.adapter,
        workflowFile: stepDef.workflow,
        foreachSource: stepDef.foreach,
        timeout: stepDef.timeout,
        onError: stepDef.on_error,
        dependsOn: stepDef.depends_on,
      },
    }));

    // Post-process: build dependsOnDisplay with order references
    const orderMap = new Map<string, string>();
    for (const child of children) {
      if (child.order) orderMap.set(child.id, child.order);
    }
    for (const child of children) {
      if (child.meta?.dependsOn && child.meta.dependsOn.length > 0) {
        child.meta.dependsOnDisplay = child.meta.dependsOn.map((dep) => {
          const order = orderMap.get(dep);
          return order ?? dep;
        });
      }
    }

    this.root = {
      id: def.name,
      label: def.name,
      type: 'workflow',
      status: 'pending',
      children,
    };
    this.endPromise = new Promise<void>((resolve) => {
      this.endResolve = resolve;
    });
    this.userExitPromise = new Promise<void>((resolve) => {
      this.userExitResolve = resolve;
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Build a WorkflowCallbacks object wired to this adapter. */
  getCallbacks(): WorkflowCallbacks {
    return {
      onWorkflowStart: (event) => this.handleWorkflowStart(event),
      onWorkflowEnd: (event) => this.handleWorkflowEnd(event),
      onStepStart: (event) => this.handleStepStart(event),
      onStepEnd: (event) => this.handleStepEnd(event),
      onStepRetry: (event) => this.handleStepRetry(event),
      onForeachProgress: (event) => this.handleForeachProgress(event),
      onInteract: (stepName, spec) => this.handleInteract(stepName, spec),
    };
  }

  /** Get the current root node (non-cloned, for internal reads). */
  getRoot(): WorkflowNode {
    return this.root;
  }

  /** Subscribe to tree updates. Returns an unsubscribe function. */
  subscribe(listener: (root: WorkflowNode) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to interaction requests. Returns an unsubscribe function. */
  onInteractRequest(listener: (reqs: InteractRequest[]) => void): () => void {
    this.interactListeners.add(listener);
    // Replay: if there are pending interacts, send the full queue
    if (this.pendingInteracts.size > 0) {
      listener(Array.from(this.pendingInteracts.values()));
    }
    return () => {
      this.interactListeners.delete(listener);
    };
  }

  /** Resolves when workflow finishes (done or failed). */
  waitForWorkflowEnd(): Promise<void> {
    return this.endPromise;
  }

  /** Resolves when the user explicitly dismisses the TUI (e.g. presses Esc after workflow ends). */
  waitForUserExit(): Promise<void> {
    return this.userExitPromise;
  }

  /** Called by the App component when user presses Esc to leave. */
  resolveUserExit(): void {
    if (this.userExitResolve) {
      this.userExitResolve();
      this.userExitResolve = null;
    }
  }

  // ─── Event handlers ──────────────────────────────────────────────────────

  private handleWorkflowStart(event: { runId: string; workflow: string; totalSteps: number; startedAt: number }): void {
    this.root.status = 'running';
    this.startedAt = event.startedAt;
    this.markDirty();
  }

  private handleWorkflowEnd(event: { runId: string; status: string; finishedAt: number }): void {
    this.root.status = event.status === 'completed' ? 'done' : 'failed';
    this.markDirty();
    this.flush();
    if (this.endResolve) {
      this.endResolve();
      this.endResolve = null;
    }
    this.resolveUserExit();
  }

  private handleStepStart(event: StepStartEvent): void {
    const path = event.stepName.split('/');
    // Try to find an existing (pre-created) node first; fall back to ensureNode for nested steps
    let node = findNode(this.root, path);
    if (!node) {
      node = ensureNode(this.root, path);
    }
    // If this is a leaf step (last segment), mark as step type unless it has children
    if (!node.children || node.children.length === 0) {
      node.type = 'step';
    }
    node.status = 'running';
    if (!node.meta) node.meta = {};
    node.meta.startedAt = Date.now();

    // Populate meta from step definition
    if (event.step) {
      if (!node.meta) node.meta = {};
      if (event.step.adapter) node.meta.adapter = event.step.adapter;
      if (event.step.workflow) node.meta.workflowFile = event.step.workflow;
      if (event.step.foreach) node.meta.foreachSource = event.step.foreach;
      if (event.step.timeout) node.meta.timeout = event.step.timeout;
      if (event.step.on_error) node.meta.onError = event.step.on_error;
      if (event.step.depends_on) node.meta.dependsOn = event.step.depends_on;
    }

    // If type is 'workflow' or has foreach, mark as workflow (container)
    if (event.step?.type === 'workflow' || event.step?.foreach) {
      node.type = 'workflow';
      if (!node.children) node.children = [];
      // Default to expand level 1 (show running/failed children) unless already set
      if (node.foreachExpandLevel === undefined) {
        node.foreachExpandLevel = 1;
      }
    }

    // Set label from description if available
    if (event.description) {
      node.label = event.description;
    }

    this.markDirty();
  }

  private handleStepEnd(event: StepEndEvent): void {
    const path = event.stepName.split('/');
    const node = findNode(this.root, path);
    if (!node) return;

    const prevStatus = node.status;

    // Auto-dismiss interact overlay if the ending step owns pending interacts.
    // Call reject() to settle the Promise (prevents leak) and clean up maps.
    // This must run BEFORE the statusMap assignment below: reject() sets
    // node.status='failed' as a side effect, which would otherwise clobber
    // the correct terminal status (e.g. 'skipped') applied afterward.
    const staleInteractIds: string[] = [];
    for (const [id, pathSegments] of this.interactStepPaths.entries()) {
      if (pathSegments.join('/') === event.stepName) {
        staleInteractIds.push(id);
      }
    }
    for (const id of staleInteractIds) {
      const req = this.pendingInteracts.get(id);
      if (req) req.reject(new Error(`step ${event.status}`));
    }

    // Map engine status to TUI status
    const statusMap: Record<string, Status> = {
      completed: 'done',
      failed: 'failed',
      skipped: 'skipped',
    };
    node.status = statusMap[event.status] ?? 'done';
    if (prevStatus !== node.status) {
      this.onTraceEvent?.(event.stepName, {
        ts: Date.now(), type: 'status_change',
        detail: { from: prevStatus, to: node.status },
      });
    }

    // Update meta
    if (!node.meta) node.meta = {};
    node.meta.durationMs = event.durationMs;
    if (event.error) node.meta.error = event.error;
    if (event.skipReason) node.meta.skipReason = event.skipReason;
    if (event.foreachErrors && event.foreachErrors.length > 0) {
      node.meta.foreachErrors = event.foreachErrors;
    }

    // Extract output file path if available
    if (event.output?.value) {
      const val = event.output.value;
      // Handle array of objects with path field (e.g. local/save-json returns [{path, size}])
      if (Array.isArray(val) && val.length > 0 && val[0]?.path) {
        node.meta.outputPath = val[0].path;
      } else if (typeof val === 'string' && (val.startsWith('/') || val.startsWith('./'))) {
        node.meta.outputPath = val;
      } else if (typeof val === 'object' && val !== null && 'path' in val) {
        node.meta.outputPath = (val as any).path;
      }
    }

    this.markDirty();
  }

  private handleStepRetry(event: StepRetryEvent): void {
    const path = event.stepName.split('/');
    const node = findNode(this.root, path);
    if (!node) return;

    node.status = 'retrying';
    if (!node.meta) node.meta = {};
    node.meta.retry = { current: event.attempt, max: event.maxRetries };
    if (event.error) node.meta.error = event.error;

    this.markDirty();
  }

  private handleForeachProgress(event: ForeachProgressEvent): void {
    const path = event.stepName.split('/');
    const node = findNode(this.root, path);
    if (!node) return;

    if (!node.meta) node.meta = {};
    node.meta.foreachProgress = {
      completed: event.completed,
      total: event.total,
      failed: event.failed,
    };

    // Propagate iteration progress to children for display
    if (node.children) {
      for (const child of node.children) {
        if (!child.meta) child.meta = {};
        child.meta.iterationTotal = event.total;
        child.meta.iterationCompleted = event.completed;
      }
    }

    this.markDirty();
  }

  private handleInteract(stepName: string, spec: ResolvedInteractSpec): Promise<unknown> {
    const path = stepName.split('/');
    const node = findNode(this.root, path);

    // The step may have already reached a terminal state by the time this fires
    // (e.g. it timed out and was marked 'skipped' while an in-flight adapter call
    // was still racing toward an auth error). Reopening an interaction here would
    // silently revert the step's displayed status — refuse instead.
    const terminalStatuses: Status[] = ['done', 'skipped', 'failed'];
    if (node && terminalStatuses.includes(node.status as Status)) {
      const reason = `step already ${node.status}`;
      this.onTraceEvent?.(stepName, {
        ts: Date.now(), type: 'interact_reject',
        detail: { reason, suppressed: true, specType: spec.type },
      });
      return Promise.reject(new Error(reason));
    }

    if (node) {
      node.status = 'interacting';
      if (!node.meta) node.meta = {};
      if ('message' in spec) {
        node.meta.interactMessage = spec.message;
      }
    }

    return new Promise<unknown>((resolve, reject) => {
      const request: InteractRequest = {
        id: `interact-${++interactCounter}`,
        stepName: stepName.split('/').pop() || stepName,
        tabLabel: node?.order ?? undefined,
        spec,
        resolve: (value: unknown) => {
          this.pendingInteracts.delete(request.id);
          this.interactStepPaths.delete(request.id);
          if (node) {
            const terminal: Status[] = ['done', 'skipped', 'failed'];
            if (!terminal.includes(node.status as Status)) {
              node.status = 'running';
            }
          }
          this.notifyInteractListeners(Array.from(this.pendingInteracts.values()));
          this.markDirty();
          this.onTraceEvent?.(stepName, {
            ts: Date.now(), type: 'interact_resolve', spanId: request.id,
            detail: { interactId: request.id },
          });
          resolve(value);
        },
        reject: (reason?: unknown) => {
          this.pendingInteracts.delete(request.id);
          this.interactStepPaths.delete(request.id);
          if (node) {
            node.status = 'failed';
          }
          this.notifyInteractListeners(Array.from(this.pendingInteracts.values()));
          this.markDirty();
          this.onTraceEvent?.(stepName, {
            ts: Date.now(), type: 'interact_reject', spanId: request.id,
            detail: { interactId: request.id, reason: reason instanceof Error ? reason.message : String(reason) },
          });
          reject(reason);
        },
      };

      this.pendingInteracts.set(request.id, request);
      this.interactStepPaths.set(request.id, path);
      this.onTraceEvent?.(stepName, {
        ts: Date.now(), type: 'interact_open', spanId: request.id,
        detail: { interactId: request.id, specType: spec.type, message: 'message' in spec ? spec.message : undefined },
      });
      this.flush();
      this.notifyInteractListeners(Array.from(this.pendingInteracts.values()));
    });
  }

  /** Collect all output file paths from the tree. */
  getOutputPaths(): string[] {
    const paths: string[] = [];
    const walk = (node: WorkflowNode) => {
      if (node.meta?.outputPath) paths.push(node.meta.outputPath);
      node.children?.forEach(walk);
    };
    walk(this.root);
    return paths;
  }

  // ─── Batching logic (16ms debounce) ──────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.dirty) {
          this.flush();
        }
      }, 16);
    }
  }

  private flush(): void {
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const snapshot = cloneTree(this.root);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private notifyInteractListeners(reqs: InteractRequest[]): void {
    for (const listener of this.interactListeners) {
      listener(reqs);
    }
  }
}

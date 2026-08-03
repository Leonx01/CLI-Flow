import type { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';
import type { WorkflowCallbacks, ResolvedInteractSpec } from '../schema/types.js';

interface InteractRequest {
  stepName: string;
  spec: ResolvedInteractSpec;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class WebAdapter {
  private wss: WebSocketServer;
  private pendingInteract: InteractRequest | null = null;

  constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  getCallbacks(): WorkflowCallbacks {
    return {
      onWorkflowStart: (e) => this.send({ type: 'workflow:start', workflow: e.workflow, totalSteps: e.totalSteps, startedAt: e.startedAt, runId: e.runId }),
      onStepStart: (e) => this.send({ type: 'step:start', stepName: e.stepName, startedAt: e.startedAt, description: e.description }),
      onStepEnd: (e) => this.send({
        type: 'step:end', stepName: e.stepName, status: e.status,
        durationMs: e.durationMs, error: e.error, skipReason: e.skipReason,
        output: e.output, foreachErrors: e.foreachErrors,
      }),
      onStepSkipped: (e) => this.send({ type: 'step:skipped', stepName: e.stepName, reason: e.reason }),
      onStepRetry: (e) => this.send({ type: 'step:retry', stepName: e.stepName, attempt: e.attempt, maxRetries: e.maxRetries, error: e.error }),
      onForeachProgress: (e) => this.send({ type: 'step:foreach', stepName: e.stepName, completed: e.completed, total: e.total, failed: e.failed }),
      onInteract: (stepName, spec) => this.handleInteract(stepName, spec),
      onInteractStart: (e) => this.send({ type: 'interact:start', stepName: e.stepName }),
      onInteractEnd: (e) => this.send({ type: 'interact:end', stepName: e.stepName, result: e.result }),
      onWorkflowEnd: (e) => this.send({ type: 'workflow:end', status: e.status }),
    };
  }

  private handleInteract(stepName: string, spec: ResolvedInteractSpec): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pendingInteract = { stepName, spec, resolve, reject };
      this.send({ type: 'interact:pending', stepName, spec });
    });
  }

  resolveInteract(answer: unknown): void {
    if (this.pendingInteract) {
      const req = this.pendingInteract;
      this.pendingInteract = null;
      req.resolve(answer);
      this.send({ type: 'interact:resolved', stepName: req.stepName, answer });
    }
  }

  private send(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    this.wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(data);
    });
  }
}

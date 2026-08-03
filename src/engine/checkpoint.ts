/**
 * Checkpoint: persist and resume workflow state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { CheckpointData } from '../schema/types.js';
import type { WorkflowDefinition } from '../schema/types.js';

const CHECKPOINTS_DIR = path.join(os.homedir(), '.cliflow', 'checkpoints');

function ensureDir(): void {
  if (!fs.existsSync(CHECKPOINTS_DIR)) {
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  }
}

function safePath(runId: string): string {
  const resolved = path.resolve(CHECKPOINTS_DIR, `${runId}.json`);
  if (!resolved.startsWith(path.resolve(CHECKPOINTS_DIR) + path.sep) &&
      resolved !== path.resolve(CHECKPOINTS_DIR)) {
    throw new Error(`Invalid runId: path traversal detected`);
  }
  return resolved;
}

export function generateRunId(): string {
  return `cfrun_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function saveCheckpoint(data: CheckpointData): void {
  ensureDir();
  const filePath = safePath(data.runId);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function loadCheckpoint(runId: string): CheckpointData | null {
  const filePath = safePath(runId);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as CheckpointData;
  } catch {
    return null;
  }
}

export function hashDefinition(definition: WorkflowDefinition): string {
  const canonical = JSON.stringify({
    steps: Object.keys(definition.steps).sort(),
    inputs: definition.inputs ? Object.keys(definition.inputs).sort() : [],
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function deleteCheckpoint(runId: string): void {
  const filePath = safePath(runId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function listCheckpoints(): CheckpointData[] {
  ensureDir();
  const files = fs.readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith('.json'));
  const checkpoints: CheckpointData[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(CHECKPOINTS_DIR, file), 'utf-8');
      checkpoints.push(JSON.parse(content) as CheckpointData);
    } catch {
      // skip corrupted files
    }
  }

  return checkpoints.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Memory: persist workflow development knowledge across sessions.
 *
 * Three file types, each with clear write semantics:
 *   notes.md       — append (prepend to top), human/agent written
 *   insights.json  — replace (read-modify-write), engine auto-written
 *   snapshots/     — append-only archive, engine auto-written on success
 *   _adapters/*.md — append (bottom), human/agent written
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function getMemoryDir(): string {
  const base = process.env.CLIFLOW_MEMORY_DIR || path.join(os.homedir(), '.cliflow');
  return path.join(base, 'memory');
}

function getMemoryBase(): string {
  return process.env.CLIFLOW_MEMORY_DIR || path.join(os.homedir(), '.cliflow');
}

// ── Path helpers ───────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, '_');
}

function workflowDir(workflowName: string): string {
  return path.join(getMemoryDir(), sanitizeName(workflowName));
}

function notesPath(workflowName: string): string {
  return path.join(workflowDir(workflowName), 'notes.md');
}

function adapterPath(site: string): string {
  return path.join(getMemoryDir(), '_adapters', `${sanitizeName(site)}.md`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface NoteEntry {
  date: string;
  hash: string;
  text: string;
  stale: boolean;
}

// ── Notes ──────────────────────────────────────────────────────────────────

export function addNote(workflowName: string, text: string, definitionHash?: string): void {
  const filePath = notesPath(workflowName);
  ensureDir(path.dirname(filePath));

  const date = new Date().toISOString().slice(0, 10);
  const hashTag = definitionHash ? ` [${definitionHash}]` : '';
  const entry = `## ${date}${hashTag}\n${text}\n`;

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  atomicWrite(filePath, existing ? `${entry}\n${existing}` : entry);
}

export function loadNotes(workflowName: string, currentHash?: string): NoteEntry[] {
  const filePath = notesPath(workflowName);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries: NoteEntry[] = [];
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const firstLine = section.split('\n')[0] ?? '';
    const rest = section.split('\n').slice(1).join('\n').trim();
    if (!rest) continue;

    const hashMatch = firstLine.match(/\[([a-f0-9]+)\]/);
    const dateMatch = firstLine.match(/^(\d{4}-\d{2}-\d{2})/);

    entries.push({
      date: dateMatch?.[1] ?? '',
      hash: hashMatch?.[1] ?? '',
      text: rest,
      stale: currentHash && hashMatch?.[1] ? hashMatch[1] !== currentHash : false,
    });
  }

  return entries;
}

export function hasNotes(workflowName: string): boolean {
  const filePath = notesPath(workflowName);
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

// ── Adapter memory ─────────────────────────────────────────────────────────

export function addAdapterNote(site: string, text: string): void {
  const filePath = adapterPath(site);
  ensureDir(path.dirname(filePath));

  if (!fs.existsSync(filePath)) {
    atomicWrite(filePath, `# ${site}\n\n- ${text}\n`);
  } else {
    const existing = fs.readFileSync(filePath, 'utf-8');
    atomicWrite(filePath, `${existing.trimEnd()}\n- ${text}\n`);
  }
}

export function loadAdapterMemory(site: string): string | null {
  const filePath = adapterPath(site);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function hasAdapterMemory(site: string): boolean {
  return fs.existsSync(adapterPath(site));
}

export function listAdapters(): string[] {
  const dir = path.join(getMemoryDir(), '_adapters');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
}

// ── Insights ───────────────────────────────────────────────────────────────

import type { WorkflowRunResult } from '../schema/types.js';

export interface RecentFailure {
  run_id: string;
  at: string;
  step: string;
  error: string;
  trace: string;
}

export interface RunInsights {
  total_runs: number;
  successes: number;
  failures: number;
  avg_duration_seconds: number;
  last_run_at: string;
  last_status: string;
  recent_failures: RecentFailure[];
}

function insightsPath(workflowName: string): string {
  return path.join(workflowDir(workflowName), 'insights.json');
}

export function loadInsights(workflowName: string): RunInsights | null {
  const filePath = insightsPath(workflowName);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RunInsights;
  } catch {
    return null;
  }
}

const MAX_RECENT_FAILURES = 10;

export function updateInsights(workflowName: string, result: WorkflowRunResult): void {
  ensureDir(workflowDir(workflowName));

  const existing = loadInsights(workflowName);
  const durationSeconds = (result.finishedAt - result.startedAt) / 1000;
  const isSuccess = result.status === 'completed';

  const totalRuns = (existing?.total_runs ?? 0) + 1;
  const successes = (existing?.successes ?? 0) + (isSuccess ? 1 : 0);
  const failures = (existing?.failures ?? 0) + (isSuccess ? 0 : 1);
  const prevAvg = existing?.avg_duration_seconds ?? 0;
  const prevCount = existing?.total_runs ?? 0;
  const avgDuration = prevCount > 0
    ? (prevAvg * prevCount + durationSeconds) / totalRuns
    : durationSeconds;

  const recentFailures = [...(existing?.recent_failures ?? [])];

  if (!isSuccess) {
    const traceFile = path.join(getMemoryBase(), 'traces', `${result.id}.trace.json`);
    for (const rec of result.stepRecords.filter(r => r.status === 'failed')) {
      recentFailures.unshift({
        run_id: result.id,
        at: new Date(result.finishedAt).toISOString(),
        step: rec.name,
        error: rec.error ?? 'unknown',
        trace: traceFile,
      });
    }
    while (recentFailures.length > MAX_RECENT_FAILURES) recentFailures.pop();
  }

  const insights: RunInsights = {
    total_runs: totalRuns,
    successes,
    failures,
    avg_duration_seconds: Math.round(avgDuration),
    last_run_at: new Date(result.finishedAt).toISOString(),
    last_status: result.status,
    recent_failures: recentFailures,
  };

  atomicWrite(insightsPath(workflowName), JSON.stringify(insights, null, 2));
}

// ── Snapshots ──────────────────────────────────────────────────────────────

export interface SnapshotEntry {
  hash: string;
  date: string;
  file: string;
  steps: string[];
}

function snapshotsDir(workflowName: string): string {
  return path.join(workflowDir(workflowName), 'snapshots');
}

export function saveSnapshot(workflowName: string, yamlFilePath: string, definitionHash: string): void {
  const dir = snapshotsDir(workflowName);
  ensureDir(dir);

  const existing = fs.readdirSync(dir).filter(f => f.includes(`_${definitionHash}.yaml`));
  if (existing.length > 0) return;

  const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const dest = path.join(dir, `${ts}_${definitionHash}.yaml`);
  fs.copyFileSync(yamlFilePath, dest);
}

export function listSnapshots(workflowName: string): SnapshotEntry[] {
  const dir = snapshotsDir(workflowName);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml'))
    .sort()
    .reverse()
    .map(file => {
      const match = file.match(/^(\d{8}T\d{4}\d?)_([a-f0-9]+)\.yaml$/);
      let hash = '';
      let date = '';
      if (match) {
        const raw = match[1];
        hash = match[2];
        date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(9, 11)}:${raw.slice(11, 13)}`;
      }

      let steps: string[] = [];
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const stepMatches = [...content.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)];
        const stepsIdx = content.search(/^steps:\s*$/m);
        if (stepsIdx !== -1) {
          const after = content.slice(stepsIdx);
          steps = [...after.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map(m => m[1]);
        }
      } catch { /* ignore parse errors */ }

      return { hash, date, file, steps };
    });
}

export function findSnapshotByHash(workflowName: string, hashPrefix: string): string | null {
  const dir = snapshotsDir(workflowName);
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find(f => f.includes(`_${hashPrefix}`) && f.endsWith('.yaml'));
  return match ? path.join(dir, match) : null;
}

export function diffSnapshots(workflowName: string, hash1: string, hash2: string): string | null {
  const file1 = findSnapshotByHash(workflowName, hash1);
  const file2 = findSnapshotByHash(workflowName, hash2);
  if (!file1 || !file2) return null;

  const lines1 = fs.readFileSync(file1, 'utf-8').split('\n');
  const lines2 = fs.readFileSync(file2, 'utf-8').split('\n');

  const out: string[] = [`--- ${hash1}`, `+++ ${hash2}`];
  const maxLen = Math.max(lines1.length, lines2.length);
  for (let i = 0; i < maxLen; i++) {
    const a = lines1[i];
    const b = lines2[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }

  return out.length > 2 ? out.join('\n') : 'No differences.';
}

// ── Aggregate queries ──────────────────────────────────────────────────────

export interface MemoryReport {
  workflowName: string;
  memoryDir: string;
  notes: NoteEntry[];
  insights: RunInsights | null;
  snapshotCount: number;
  adapterNotes: string[];
}

export function loadMemory(workflowName: string, currentHash?: string): MemoryReport {
  const notes = loadNotes(workflowName, currentHash);
  const insights = loadInsights(workflowName);
  const sDir = snapshotsDir(workflowName);
  const snapshotCount = fs.existsSync(sDir)
    ? fs.readdirSync(sDir).filter(f => f.endsWith('.yaml')).length
    : 0;

  return {
    workflowName,
    memoryDir: workflowDir(workflowName),
    notes,
    insights,
    snapshotCount,
    adapterNotes: listAdapters(),
  };
}

export function deleteMemory(workflowName: string): boolean {
  const dir = workflowDir(workflowName);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function listMemories(): Array<{ workflow: string; noteCount: number; runs: number; successRate: string; lastRun: string }> {
  if (!fs.existsSync(getMemoryDir())) return [];

  const results: Array<{ workflow: string; noteCount: number; runs: number; successRate: string; lastRun: string }> = [];

  for (const entry of fs.readdirSync(getMemoryDir())) {
    if (entry.startsWith('_')) continue;
    const dir = path.join(getMemoryDir(), entry);
    if (!fs.statSync(dir).isDirectory()) continue;

    const noteCount = loadNotes(entry).length;
    const insights = loadInsights(entry);
    results.push({
      workflow: entry,
      noteCount,
      runs: insights?.total_runs ?? 0,
      successRate: insights && insights.total_runs > 0
        ? `${Math.round((insights.successes / insights.total_runs) * 100)}%`
        : '—',
      lastRun: insights?.last_run_at?.slice(0, 10) ?? '—',
    });
  }

  return results.sort((a, b) => (b.lastRun > a.lastRun ? 1 : -1));
}

// ── Hint ───────────────────────────────────────────────────────────────────

import type { WorkflowDefinition } from '../schema/types.js';
import { hashDefinition } from './checkpoint.js';

export function getMemoryHint(
  workflowName: string,
  result: WorkflowRunResult,
  definition: WorkflowDefinition,
  yamlFilePath: string,
): string | null {
  const failed = result.status !== 'completed';

  if (failed && hasNotes(workflowName)) {
    return `hint: run \`cliflow memory ${workflowName}\` to check related notes`;
  }

  if (failed) {
    for (const rec of result.stepRecords.filter(r => r.status === 'failed')) {
      const adapterName = definition.steps[rec.name]?.adapter;
      if (adapterName) {
        const site = adapterName.split('/')[0];
        if (hasAdapterMemory(site)) {
          return `hint: run \`cliflow memory adapter ${site}\` to check known issues`;
        }
      }
    }
  }

  if (failed) {
    return `hint: after fixing, run \`cliflow memory ${workflowName} add "<note>" --file ${yamlFilePath}\``;
  }

  if (!loadInsights(workflowName)) {
    return `hint: run \`cliflow memory ${workflowName} add "<note>" --file ${yamlFilePath}\` to save findings`;
  }

  if (hasNotes(workflowName)) {
    const currentHash = hashDefinition(definition);
    const notes = loadNotes(workflowName, currentHash);
    if (notes.some(n => n.stale)) {
      return `hint: run \`cliflow memory ${workflowName}\` to review stale notes`;
    }
  }

  return null;
}

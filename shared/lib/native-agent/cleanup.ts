import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PROCESS_GRACE_MS = 2_000;
const MAX_TRACKED_ITEMS = 10_000;

export type TreeState = 'clean' | 'dirty-recoverable' | 'dirty-unrecoverable';
export type CleanupDecision = 'no-action-needed' | 'rolled-back' | 'partial-rollback' | 'left-in-place';
export type MutationStatus = 'completed' | 'failed' | 'not-attempted';
export type CleanupReason = 'aborted' | 'timeout';
export type RollbackStatus = 'restored' | 'skipped' | 'missing-preimage';

export interface MutationAttempt {
  tool: string;
  status: MutationStatus;
  path?: string;
  reason?: string;
}

export interface PatchSnapshot {
  path: string;
  originalDiskText: string;
  postImage: string;
}

export interface TerminatedCommand {
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL' | null;
  alreadyExited: boolean;
}

export interface RollbackResult {
  path: string;
  status: RollbackStatus;
}

export interface CleanupReport {
  reason: CleanupReason;
  terminatedCommands: TerminatedCommand[];
  partialMutations: MutationAttempt[];
  finalTreeState: TreeState;
  cleanupDecision: CleanupDecision;
  runTouchedPaths: string[];
  rollbackResults: RollbackResult[];
  notes: string[];
}

export interface MutationRecorder {
  recordMutation(attempt: MutationAttempt): void;
  recordPatchSnapshots(snapshots: PatchSnapshot[]): void;
}

export interface ProcessHandle {
  pid: number;
  kill(signal: NodeJS.Signals): boolean;
}

export interface CleanupTracker extends MutationRecorder {
  readonly processHandles: readonly ProcessHandle[];
  readonly mutations: readonly MutationAttempt[];
  readonly patchSnapshots: readonly PatchSnapshot[];
  readonly consumed: boolean;
  readonly summaryMode: boolean;
  readonly notes: readonly string[];
  registerProcess(handle: ProcessHandle): void;
}

interface MutableCleanupTracker extends CleanupTracker {
  processHandles: ProcessHandle[];
  mutations: MutationAttempt[];
  patchSnapshots: PatchSnapshot[];
  consumed: boolean;
  summaryMode: boolean;
  notes: string[];
}

function normalizeTrackedPath(inputPath: string): string {
  return inputPath.split(path.sep).join('/');
}

function addCapacityNote(tracker: MutableCleanupTracker): void {
  if (tracker.summaryMode) {
    return;
  }
  tracker.summaryMode = true;
  tracker.notes.push('Cleanup tracker reached capacity; later entries were summarized only.');
}

export function createCleanupTracker(): CleanupTracker {
  const tracker: MutableCleanupTracker = {
    processHandles: [],
    mutations: [],
    patchSnapshots: [],
    consumed: false,
    summaryMode: false,
    notes: [],
    registerProcess(handle) {
      if (this.processHandles.length >= MAX_TRACKED_ITEMS) {
        addCapacityNote(this);
        return;
      }
      this.processHandles.push(handle);
    },
    recordMutation(attempt) {
      if (this.mutations.length >= MAX_TRACKED_ITEMS) {
        addCapacityNote(this);
        return;
      }
      this.mutations.push({
        ...attempt,
        ...(attempt.path ? { path: normalizeTrackedPath(attempt.path) } : {}),
      });
    },
    recordPatchSnapshots(snapshots) {
      for (const snapshot of snapshots) {
        if (this.patchSnapshots.length >= MAX_TRACKED_ITEMS) {
          addCapacityNote(this);
          return;
        }
        this.patchSnapshots.push({
          ...snapshot,
          path: normalizeTrackedPath(snapshot.path),
        });
      }
    },
  };
  return tracker;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function tryKill(handle: ProcessHandle, signal: NodeJS.Signals): boolean {
  try {
    return handle.kill(signal);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') {
      return false;
    }
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateProcesses(
  handles: readonly ProcessHandle[],
  graceMs = DEFAULT_PROCESS_GRACE_MS,
): Promise<TerminatedCommand[]> {
  const results = handles.map<TerminatedCommand>((handle) => ({
    pid: handle.pid,
    signal: null,
    alreadyExited: !isProcessAlive(handle.pid),
  }));

  for (const [index, handle] of handles.entries()) {
    if (results[index]!.alreadyExited) {
      continue;
    }
    tryKill(handle, 'SIGTERM');
    results[index]!.signal = 'SIGTERM';
  }

  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    const alive = results.some((result) => !result.alreadyExited && isProcessAlive(result.pid));
    if (!alive) {
      return results.map((result) => ({
        ...result,
        alreadyExited: result.alreadyExited || !isProcessAlive(result.pid),
      }));
    }
    await sleep(25);
  }

  for (const [index, handle] of handles.entries()) {
    if (results[index]!.alreadyExited || !isProcessAlive(handle.pid)) {
      continue;
    }
    tryKill(handle, 'SIGKILL');
    results[index]!.signal = 'SIGKILL';
  }

  return results.map((result) => ({
    ...result,
    alreadyExited: result.alreadyExited || !isProcessAlive(result.pid),
  }));
}

function atomicWriteText(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, filePath);
}

async function readDiskText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function rollbackPatches(
  worktreePath: string,
  snapshots: readonly PatchSnapshot[],
): Promise<RollbackResult[]> {
  const results: RollbackResult[] = [];
  for (const snapshot of snapshots) {
    const absolutePath = path.join(worktreePath, snapshot.path);
    const currentDiskText = await readDiskText(absolutePath);
    if (currentDiskText === null) {
      results.push({ path: snapshot.path, status: 'missing-preimage' });
      continue;
    }
    if (currentDiskText !== snapshot.postImage) {
      results.push({ path: snapshot.path, status: 'skipped' });
      continue;
    }
    atomicWriteText(absolutePath, snapshot.originalDiskText);
    results.push({ path: snapshot.path, status: 'restored' });
  }
  return results;
}

async function gitStatusPaths(
  worktreePath: string,
  runTouchedPaths: readonly string[],
): Promise<{ dirtyPaths: Set<string>; note?: string }> {
  if (runTouchedPaths.length === 0) {
    return { dirtyPaths: new Set<string>() };
  }

  return await new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain=v2', '-z', '--', ...runTouchedPaths], {
      cwd: worktreePath,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      resolve({
        dirtyPaths: new Set<string>(runTouchedPaths),
        note: `git status failed: ${error.message}`,
      });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        resolve({
          dirtyPaths: new Set<string>(runTouchedPaths),
          note: stderr || 'git status failed',
        });
        return;
      }

      const tokens = Buffer.concat(stdoutChunks).toString('utf8').split('\0').filter(Boolean);
      const dirtyPaths = new Set<string>();
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token.startsWith('# ')) {
          continue;
        }
        if (token.startsWith('? ') || token.startsWith('! ')) {
          dirtyPaths.add(normalizeTrackedPath(token.slice(2)));
          continue;
        }
        if (token.startsWith('1 ')) {
          const parts = token.split(' ');
          dirtyPaths.add(normalizeTrackedPath(parts[8] ?? ''));
          continue;
        }
        if (token.startsWith('2 ')) {
          const parts = token.split(' ');
          dirtyPaths.add(normalizeTrackedPath(parts[9] ?? ''));
          index += 1;
          continue;
        }
        if (token.startsWith('u ')) {
          const parts = token.split(' ');
          dirtyPaths.add(normalizeTrackedPath(parts[10] ?? ''));
        }
      }
      resolve({ dirtyPaths });
    });
  });
}

export async function classifyTree(
  worktreePath: string,
  runTouchedPaths: readonly string[],
  rollbackResults: readonly RollbackResult[] = [],
): Promise<{ finalTreeState: TreeState; cleanupDecision: CleanupDecision; notes: string[] }> {
  const notes: string[] = [];
  const normalizedPaths = Array.from(new Set(runTouchedPaths.map(normalizeTrackedPath))).filter(Boolean).sort();
  const gitState = await gitStatusPaths(worktreePath, normalizedPaths);
  if (gitState.note) {
    notes.push(gitState.note);
  }

  const restored = rollbackResults.filter((result) => result.status === 'restored').length;
  const unrecoverable = rollbackResults.filter((result) => result.status !== 'restored').length;
  const dirtyCount = gitState.dirtyPaths.size;

  if (normalizedPaths.length === 0 && dirtyCount === 0) {
    return { finalTreeState: 'clean', cleanupDecision: 'no-action-needed', notes };
  }
  if (dirtyCount === 0) {
    return {
      finalTreeState: 'clean',
      cleanupDecision: restored > 0 ? 'rolled-back' : 'no-action-needed',
      notes,
    };
  }
  if (restored > 0 && unrecoverable > 0) {
    return { finalTreeState: 'dirty-unrecoverable', cleanupDecision: 'partial-rollback', notes };
  }
  if (restored > 0) {
    return { finalTreeState: 'dirty-recoverable', cleanupDecision: 'partial-rollback', notes };
  }
  return { finalTreeState: 'dirty-unrecoverable', cleanupDecision: 'left-in-place', notes };
}

export async function runCleanup(
  tracker: CleanupTracker,
  options: { worktreePath: string; reason: CleanupReason; graceMs?: number },
): Promise<CleanupReport> {
  if (tracker.consumed) {
    return {
      reason: options.reason,
      terminatedCommands: [],
      partialMutations: [],
      finalTreeState: 'clean',
      cleanupDecision: 'no-action-needed',
      runTouchedPaths: [],
      rollbackResults: [],
      notes: ['Cleanup tracker already consumed.'],
    };
  }

  (tracker as MutableCleanupTracker).consumed = true;
  const terminatedCommands = await terminateProcesses(tracker.processHandles, options.graceMs);
  const rollbackResults = await rollbackPatches(options.worktreePath, tracker.patchSnapshots);
  const runTouchedPaths = Array.from(new Set([
    ...tracker.patchSnapshots.map((snapshot) => snapshot.path),
    ...tracker.mutations
      .filter((mutation) => mutation.status === 'completed' && mutation.path)
      .map((mutation) => mutation.path as string),
  ])).sort();
  const classification = await classifyTree(options.worktreePath, runTouchedPaths, rollbackResults);

  return {
    reason: options.reason,
    terminatedCommands,
    partialMutations: [...tracker.mutations],
    finalTreeState: classification.finalTreeState,
    cleanupDecision: classification.cleanupDecision,
    runTouchedPaths,
    rollbackResults,
    notes: [...tracker.notes, ...classification.notes],
  };
}

export function formatCleanupTranscriptLine(report: CleanupReport): string {
  return `cleanup reason=${report.reason} tree=${report.finalTreeState} decision=${report.cleanupDecision}`;
}

export function writeCleanupSummaryEvent(
  report: CleanupReport,
): { type: 'cleanup_report'; reason: CleanupReason; finalTreeState: TreeState; cleanupDecision: CleanupDecision; notes?: string[] } {
  return {
    type: 'cleanup_report',
    reason: report.reason,
    finalTreeState: report.finalTreeState,
    cleanupDecision: report.cleanupDecision,
    ...(report.notes.length > 0 ? { notes: report.notes } : {}),
  };
}

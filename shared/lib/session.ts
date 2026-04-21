// Session metadata capture and persistence for wavemill workflows.
// All operations are non-intrusive: wrapped in try/catch, never throw, never block.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from 'crypto';
import { join } from "node:path";
import { closeManifest, openManifest } from './resource-manifest.ts';

export type WorkflowType = 'feature' | 'bugfix' | 'plan' | 'validate-plan' | 'implement-plan';
export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SessionMetadata {
  schemaVersion?: string;
  sessionId: string;
  workflowType: WorkflowType;
  issueId?: string;
  prompt: string;
  model: string;
  modelVersion?: string;
  startedAt: string;
  completedAt?: string;
  executionTimeMs?: number;
  userWaitTimeMs?: number;
  prIdentifier?: string;
  status: SessionStatus;
  error?: string;
}

interface CreateSessionOpts {
  workflowType: WorkflowType;
  prompt: string;
  model: string;
  modelVersion?: string;
  issueId?: string;
  repoDir?: string;
}

interface CompleteSessionOpts {
  executionTimeMs?: number;
  userWaitTimeMs?: number;
  status: SessionStatus;
  prIdentifier?: string;
  error?: string;
  repoDir?: string;
}

const SCHEMA_VERSION = '1.0.0';

/**
 * Resolve the sessions directory, creating it if needed.
 */
async function sessionsDir(repoDir?: string): Promise<string> {
  const dir = join(repoDir || process.cwd(), '.wavemill', 'sessions');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Write a session to disk (both latest.json and archive).
 */
async function persist(dir: string, session: SessionMetadata): Promise<void> {
  const json = JSON.stringify(session, null, 2);
  await Promise.all([
    writeFile(join(dir, 'latest.json'), json, 'utf-8'),
    writeFile(join(dir, `${session.sessionId}.json`), json, 'utf-8'),
  ]);
}

/**
 * Create a new session and persist it with status 'running'.
 *
 * @returns sessionId, or null on failure
 */
export async function createSession(opts: CreateSessionOpts): Promise<string | null> {
  try {
    const dir = await sessionsDir(opts?.repoDir);
    const session: SessionMetadata = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: randomUUID(),
      workflowType: opts.workflowType,
      ...(opts.issueId && { issueId: opts.issueId }),
      prompt: opts.prompt || '',
      model: opts.model || 'unknown',
      ...(opts.modelVersion && { modelVersion: opts.modelVersion }),
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    await persist(dir, session);
    try {
      openManifest(session.sessionId, {
        workflowType: session.workflowType,
        repoDir: opts?.repoDir,
      });
    } catch (err) {
      console.warn(`[manifest] Failed to open manifest for ${session.sessionId}: ${(err as Error).message}`);
    }
    return session.sessionId;
  } catch (err) {
    console.warn(`[session] Failed to create session: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Merge updates into an existing session file.
 */
export async function updateSession(sessionId: string, updates: Partial<SessionMetadata>, repoDir?: string): Promise<boolean> {
  try {
    const dir = await sessionsDir(repoDir);
    const filePath = join(dir, `${sessionId}.json`);
    const existing: SessionMetadata = JSON.parse(await readFile(filePath, 'utf-8'));
    const merged = { ...existing, ...updates };
    await persist(dir, merged);
    return true;
  } catch (err) {
    console.warn(`[session] Failed to update session ${sessionId}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Finalize a session with completion details.
 */
export async function completeSession(sessionId: string, opts: CompleteSessionOpts): Promise<boolean> {
  try {
    const dir = await sessionsDir(opts?.repoDir);
    const filePath = join(dir, `${sessionId}.json`);
    const existing: SessionMetadata = JSON.parse(await readFile(filePath, 'utf-8'));
    const merged: SessionMetadata = {
      ...existing,
      completedAt: new Date().toISOString(),
      status: opts.status || 'completed',
      ...(opts.executionTimeMs !== undefined && { executionTimeMs: opts.executionTimeMs }),
      ...(opts.userWaitTimeMs !== undefined && { userWaitTimeMs: opts.userWaitTimeMs }),
      ...(opts.prIdentifier && { prIdentifier: opts.prIdentifier }),
      ...(opts.error && { error: opts.error }),
    };
    await persist(dir, merged);
    try {
      closeManifest(sessionId, {
        status: merged.status,
        repoDir: opts?.repoDir,
      });
    } catch (err) {
      console.warn(`[manifest] Failed to close manifest for ${sessionId}: ${(err as Error).message}`);
    }
    return true;
  } catch (err) {
    console.warn(`[session] Failed to complete session ${sessionId}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Read the most recent session from latest.json.
 */
export async function getLatestSession(repoDir?: string): Promise<SessionMetadata | null> {
  try {
    const dir = await sessionsDir(repoDir);
    const filePath = join(dir, 'latest.json');
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[session] Failed to read latest session: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Read a specific session by ID.
 */
export async function getSession(sessionId: string, repoDir?: string): Promise<SessionMetadata | null> {
  try {
    const dir = await sessionsDir(repoDir);
    const filePath = join(dir, `${sessionId}.json`);
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err) {
    console.warn(`[session] Failed to read session ${sessionId}: ${(err as Error).message}`);
    return null;
  }
}

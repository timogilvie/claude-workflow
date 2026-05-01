import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState, StateLockTimeoutError } from './state-mutex.ts';

export const CACHE_SCHEMA_VERSION = 1;
const CACHE_WRITE_TIMEOUT_MS = 100;

export interface CachedEdge {
  from: string;
  to: string;
  fromFingerprint: string;
  toFingerprint: string;
  kind: 'inferred';
  label?: string;
  confidence?: number;
  classifiedAt: string;
}

export interface CacheFile {
  schemaVersion: 1;
  projectSlug: string;
  updatedAt: string;
  fingerprints: Record<string, string>;
  edges: CachedEdge[];
}

export interface FingerprintableTask {
  id: string;
  title?: unknown;
  description?: unknown;
  labels?: unknown;
  priority?: unknown;
  estimate?: unknown;
  state?: unknown;
  blocks?: unknown;
}

interface CacheStats {
  totalEdges: number;
  retainedEdges: number;
}

function emptyCache(projectSlug: string): CacheFile {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    projectSlug,
    updatedAt: new Date(0).toISOString(),
    fingerprints: {},
    edges: [],
  };
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice()
    .sort((a, b) => a.localeCompare(b));
}

function normalizeState(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const name = (value as { name?: unknown }).name;
  if (typeof name === 'string') return name;

  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function canonicalizeTask(task: FingerprintableTask): Record<string, unknown> {
  return {
    blocks: normalizeStringArray(task.blocks),
    description: normalizeString(task.description),
    estimate: task.estimate ?? null,
    id: task.id,
    labels: normalizeStringArray(task.labels),
    priority: task.priority ?? null,
    state: normalizeState(task.state),
    title: normalizeString(task.title),
  };
}

function sortedRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCachedEdge(value: unknown): value is CachedEdge {
  if (!isRecord(value)) return false;
  return (
    value.kind === 'inferred' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.fromFingerprint === 'string' &&
    typeof value.toFingerprint === 'string' &&
    typeof value.classifiedAt === 'string' &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.confidence === undefined || typeof value.confidence === 'number')
  );
}

function isCacheFile(value: unknown): value is CacheFile {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (typeof value.projectSlug !== 'string' || typeof value.updatedAt !== 'string') return false;
  if (!isRecord(value.fingerprints) || !Array.isArray(value.edges)) return false;
  if (Object.values(value.fingerprints).some((fingerprint) => typeof fingerprint !== 'string')) return false;
  return value.edges.every(isCachedEdge);
}

function validateProjectSlug(projectSlug: string): void {
  if (projectSlug.includes('/') || projectSlug.includes('\\') || projectSlug.includes('..')) {
    throw new Error(`Invalid project slug for task dependency cache: ${projectSlug}`);
  }
}

export function getTaskDependencyCachePath(repoDir: string, projectSlug: string): string {
  validateProjectSlug(projectSlug);
  return join(repoDir, '.wavemill', 'cache', 'task-dependency-plans', `${projectSlug}.json`);
}

export function computeTaskFingerprint(task: FingerprintableTask): string {
  const payload = JSON.stringify(sortedRecord(canonicalizeTask(task)));
  return createHash('sha256').update(payload).digest('hex');
}

export function loadCache(rawRepoDir: string, projectSlug: string): CacheFile {
  const cachePath = getTaskDependencyCachePath(rawRepoDir, projectSlug);
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
    if (!isCacheFile(raw)) {
      console.warn(`[task-dep-cache] dropping unreadable cache: invalid shape in ${cachePath}`);
      return emptyCache(projectSlug);
    }
    if (raw.projectSlug !== projectSlug) {
      console.warn(`[task-dep-cache] dropping unreadable cache: project slug mismatch in ${cachePath}`);
      return emptyCache(projectSlug);
    }
    return raw;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') return emptyCache(projectSlug);
    if (error instanceof SyntaxError) {
      console.warn(`[task-dep-cache] dropping unreadable cache: invalid JSON in ${cachePath}`);
      return emptyCache(projectSlug);
    }
    console.warn(`[task-dep-cache] dropping unreadable cache: ${(error as Error).message}`);
    return emptyCache(projectSlug);
  }
}

export function pruneCache(cache: CacheFile, currentBacklog: FingerprintableTask[]): CacheFile {
  const fingerprints = Object.fromEntries(currentBacklog.map((task) => [task.id, computeTaskFingerprint(task)]));
  const edges = cache.edges.filter(
    (edge) => fingerprints[edge.from] === edge.fromFingerprint && fingerprints[edge.to] === edge.toFingerprint,
  );

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    projectSlug: cache.projectSlug,
    updatedAt: cache.updatedAt,
    fingerprints,
    edges,
  };
}

export function getCacheStats(before: CacheFile, after: CacheFile): CacheStats {
  return {
    totalEdges: before.edges.length,
    retainedEdges: after.edges.length,
  };
}

export function lookupEdge(
  cache: CacheFile,
  fromId: string,
  toId: string,
  fromFingerprint: string,
  toFingerprint: string,
): CachedEdge | undefined {
  return cache.edges.find(
    (edge) =>
      (
        edge.from === fromId &&
        edge.to === toId &&
        edge.fromFingerprint === fromFingerprint &&
        edge.toFingerprint === toFingerprint
      ) ||
      (
        edge.from === toId &&
        edge.to === fromId &&
        edge.fromFingerprint === toFingerprint &&
        edge.toFingerprint === fromFingerprint
      ),
  );
}

export function recordEdge(cache: CacheFile, edge: CachedEdge): CacheFile {
  return {
    ...cache,
    edges: [...cache.edges, edge],
  };
}

export async function saveCache(repoDir: string, projectSlug: string, cache: CacheFile): Promise<void> {
  let cachePath: string;
  try {
    cachePath = getTaskDependencyCachePath(repoDir, projectSlug);
  } catch (error) {
    console.warn(`[task-dep-cache] ${(error as Error).message}`);
    return;
  }

  try {
    await mutateJsonState<CacheFile>(
      cachePath,
      () => ({
        ...cache,
        schemaVersion: CACHE_SCHEMA_VERSION,
        projectSlug,
        updatedAt: new Date().toISOString(),
      }),
      { createIfMissing: true, initial: cache, timeoutMs: CACHE_WRITE_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof StateLockTimeoutError) {
      console.warn(`[task-dep-cache] cache write skipped after lock timeout: ${cachePath}`);
      return;
    }
    console.warn(`[task-dep-cache] cache write failed: ${(error as Error).message}`);
  }
}

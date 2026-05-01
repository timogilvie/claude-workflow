import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mutateJsonState, StateParseError } from './state-mutex.ts';
import type { OperatingMode } from './operating-mode.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

export const EXPANDED_ROUTE_CACHE_INPUT_VERSION = '1';

export interface ExpandedPacketFiles {
  packetFile?: string;
  headerFile?: string;
  detailsFile?: string;
}

export interface ExpandedPacketContent {
  prompt: string;
  provenancePath: string;
  hash: string;
}

export interface ExpandedRouteCacheEntry {
  packet_hash: string;
  decision: WorkflowRouteDecision;
  operating_mode: OperatingMode;
  recorded_at: string;
  input_version?: string;
}

interface ExpandedRouteCacheState {
  version: 1;
  entries: Record<string, ExpandedRouteCacheEntry>;
}

function warnCache(message: string): void {
  process.stderr.write(`[router] expanded route cache warning: ${message}\n`);
}

export function getExpandedRouteCachePath(repoDir: string): string {
  return path.join(repoDir, '.wavemill', 'state', 'expanded-route-cache.json');
}

function buildSplitPacketPrompt(header: string, details: string): string {
  return `${header}\n\n${details}`;
}

function buildSplitPacketHashInput(header: string, details: string, version: string): string {
  return `${header}\n--SPLIT--\n${details}\n--VERSION--\n${version}`;
}

export function readExpandedPacketContent(
  files: ExpandedPacketFiles,
  version = EXPANDED_ROUTE_CACHE_INPUT_VERSION,
): ExpandedPacketContent {
  if (files.packetFile) {
    const bytes = readFileSync(files.packetFile);
    return {
      prompt: bytes.toString('utf-8'),
      provenancePath: files.packetFile,
      hash: createHash('sha256')
        .update(bytes)
        .update(`\n--VERSION--\n${version}`, 'utf-8')
        .digest('hex'),
    };
  }

  if (!files.headerFile || !files.detailsFile) {
    throw new Error('Expanded packet input requires packetFile or both headerFile and detailsFile');
  }

  const header = readFileSync(files.headerFile, 'utf-8');
  const details = readFileSync(files.detailsFile, 'utf-8');
  return {
    prompt: buildSplitPacketPrompt(header, details),
    provenancePath: files.headerFile,
    hash: createHash('sha256')
      .update(buildSplitPacketHashInput(header, details, version), 'utf-8')
      .digest('hex'),
  };
}

function readCacheState(repoDir: string): ExpandedRouteCacheState | null {
  const cachePath = getExpandedRouteCachePath(repoDir);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as Partial<ExpandedRouteCacheState>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      warnCache(`invalid structure at ${cachePath}`);
      return null;
    }
    return {
      version: 1,
      entries: parsed.entries,
    };
  } catch (error) {
    warnCache(`failed to parse ${cachePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function lookupExpandedRouteCache(
  repoDir: string,
  packetHash: string,
  operatingMode: OperatingMode,
): ExpandedRouteCacheEntry | null {
  const state = readCacheState(repoDir);
  if (!state) {
    return null;
  }

  const entry = state.entries[packetHash];
  if (!entry) {
    return null;
  }

  if (entry.operating_mode !== operatingMode) {
    return null;
  }

  return entry;
}

export async function recordExpandedRouteCache(
  repoDir: string,
  entry: ExpandedRouteCacheEntry,
): Promise<void> {
  const cachePath = getExpandedRouteCachePath(repoDir);
  const initialState: ExpandedRouteCacheState = { version: 1, entries: {} };

  const writeEntry = async (): Promise<void> => {
    await mutateJsonState<ExpandedRouteCacheState>(
      cachePath,
      (current) => ({
        version: 1,
        entries: {
          ...(current.entries || {}),
          [entry.packet_hash]: entry,
        },
      }),
      {
        createIfMissing: true,
        initial: initialState,
      },
    );
  };

  try {
    await writeEntry();
  } catch (error) {
    if (!(error instanceof StateParseError)) {
      throw error;
    }

    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(initialState, null, 2)}\n`, 'utf-8');
    await writeEntry();
  }
}

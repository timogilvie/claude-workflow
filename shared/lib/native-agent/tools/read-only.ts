// ---------------------------------------------------------------------------
// Native read-only tool implementations: read_file, list_files, search_text.
// Create descriptors via createReadOnlyTools(worktreePath) so each executor
// closes over the resolved worktree root.
// ---------------------------------------------------------------------------

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { buildTrustMetadata } from '../provenance.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_READ_FILE_BYTES = 256 * 1024;
const MAX_LIST_FILES_RESULTS = 1000;
const MAX_SEARCH_TEXT_RESULTS = 200;
const MAX_SEARCH_LINE_BYTES = 512;

// ---------------------------------------------------------------------------
// Node 22 glob API (no @types/node for this yet — cast required)
// ---------------------------------------------------------------------------

interface GlobDirent {
  name: string;
  parentPath: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface GlobOptions {
  cwd?: string;
  withFileTypes?: boolean;
  follow?: boolean;
  exclude?: (path: string) => boolean;
}

const { glob: nodeGlob } = fsPromises as unknown as {
  glob(pattern: string, options: GlobOptions & { withFileTypes: true }): AsyncIterable<GlobDirent>;
  glob(pattern: string, options?: GlobOptions): AsyncIterable<string>;
};

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

export interface ReadFileParams {
  path: string;
  startLine?: number;
  maxLines?: number;
}

export interface ListFilesParams {
  path?: string;
  glob?: string;
  maxResults?: number;
}

export interface SearchTextParams {
  query: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

// ---------------------------------------------------------------------------
// Detail types
// ---------------------------------------------------------------------------

export interface ReadFileDetails {
  path: string;
  startLine: number;
  returnedLines: number;
  totalLines: number;
  truncated: boolean;
  truncationReason?: 'maxLines' | 'maxBytes';
}

export interface ListFilesDetails {
  path: string;
  glob: string | null;
  count: number;
  truncated: boolean;
  maxResults: number;
}

export interface SearchTextDetails {
  query: string;
  path: string;
  glob: string | null;
  caseSensitive: boolean;
  matchCount: number;
  truncated: boolean;
  maxResults: number;
}

export interface ToolErrorDetails {
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeError(code: string, message: string): WavemillToolResult<ToolErrorDetails> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
    details: { error: code, message },
    metadata: { trust: buildTrustMetadata({ sourceKind: 'file', details: { error: code, message } }) },
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

function looksLikeBinary(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Path resolution (lexical + realpath containment check)
// ---------------------------------------------------------------------------

export interface PathOk {
  kind: 'ok';
  absolutePath: string;
  relativePath: string;
}
export interface PathErr {
  kind: 'error';
  code: string;
  message: string;
}

export async function resolveInsideWorktree(
  worktreeAbsolute: string,
  inputPath: string,
): Promise<PathOk | PathErr> {
  if (!inputPath || typeof inputPath !== 'string') {
    return { kind: 'error', code: 'invalid_params', message: 'path must be a non-empty string' };
  }

  // Normalize Windows-style separators before any path resolution so that
  // '..\\secrets.env' is treated as '../secrets.env' rather than a literal
  // backslash filename (consistent with policies.ts toComparablePath behavior).
  const normalizedInput = inputPath.replace(/\\/g, '/');

  const candidate = path.isAbsolute(normalizedInput)
    ? path.normalize(normalizedInput)
    : path.resolve(worktreeAbsolute, normalizedInput);

  // Lexical containment check (catches ../.. without filesystem access)
  const sep = path.sep;
  const withSep = worktreeAbsolute.endsWith(sep) ? worktreeAbsolute : worktreeAbsolute + sep;
  if (candidate !== worktreeAbsolute && !candidate.startsWith(withSep)) {
    return {
      kind: 'error',
      code: 'path_outside_worktree',
      message: `'${inputPath}' resolves outside the worktree`,
    };
  }

  // Realpath to detect symlink escapes
  let realCandidate: string;
  try {
    realCandidate = await fsPromises.realpath(candidate);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { kind: 'error', code: 'not_found', message: `'${inputPath}' does not exist` };
    }
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return {
        kind: 'error',
        code: 'permission_denied',
        message: `Cannot access '${inputPath}': permission denied`,
      };
    }
    return {
      kind: 'error',
      code: 'io_error',
      message: `Cannot access '${inputPath}': ${e.message}`,
    };
  }

  let realWorktree: string;
  try {
    realWorktree = await fsPromises.realpath(worktreeAbsolute);
  } catch {
    realWorktree = worktreeAbsolute;
  }

  const realWithSep = realWorktree.endsWith(sep) ? realWorktree : realWorktree + sep;
  if (realCandidate !== realWorktree && !realCandidate.startsWith(realWithSep)) {
    return {
      kind: 'error',
      code: 'path_outside_worktree',
      message: `'${inputPath}' escapes the worktree via symlink`,
    };
  }

  const relativePath = path.relative(realWorktree, realCandidate) || '.';
  return { kind: 'ok', absolutePath: realCandidate, relativePath };
}

// ---------------------------------------------------------------------------
// Symlink containment check for glob entries
// Returns true if the symlink resolves inside the worktree.
// ---------------------------------------------------------------------------

async function symlinkIsInsideWorktree(
  absPath: string,
  realWorktree: string,
): Promise<boolean> {
  try {
    const real = await fsPromises.realpath(absPath);
    const sep = path.sep;
    const withSep = realWorktree.endsWith(sep) ? realWorktree : realWorktree + sep;
    return real === realWorktree || real.startsWith(withSep);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// read_file executor
// ---------------------------------------------------------------------------

async function executeReadFile(
  worktreeAbsolute: string,
  _toolCallId: string,
  params: ReadFileParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<ReadFileDetails | ToolErrorDetails>> {
  if (!params.path || typeof params.path !== 'string') {
    return makeError('invalid_params', 'path is required');
  }

  const resolved = await resolveInsideWorktree(worktreeAbsolute, params.path);
  if (resolved.kind === 'error') return makeError(resolved.code, resolved.message);

  const stat = await fsPromises.stat(resolved.absolutePath).catch(() => null);
  if (!stat) return makeError('not_found', `'${params.path}' does not exist`);
  if (stat.isDirectory()) {
    return makeError('not_a_file', `'${params.path}' is a directory, not a file`);
  }

  let buf: Buffer;
  try {
    buf = await fsPromises.readFile(resolved.absolutePath, { signal });
  } catch (err: unknown) {
    return makeError('io_error', `Cannot read '${params.path}': ${(err as Error).message}`);
  }

  if (looksLikeBinary(buf)) {
    return makeError('binary_file', `'${params.path}' appears to be a binary file`);
  }

  const fileText = buf.toString('utf8');
  const allLines = fileText.split('\n');
  const totalLines = allLines.length;

  const startLine = Math.max(1, Math.floor(params.startLine ?? 1));
  const maxLinesRaw = params.maxLines !== undefined ? Math.max(1, Math.floor(params.maxLines)) : undefined;
  const sliceStart = startLine - 1;
  const sliceEnd = maxLinesRaw !== undefined ? sliceStart + maxLinesRaw : undefined;
  let slicedLines = allLines.slice(sliceStart, sliceEnd);

  const lineLimitTruncated = sliceEnd !== undefined && slicedLines.length < allLines.slice(sliceStart).length;
  let truncationReason: 'maxLines' | 'maxBytes' | undefined = lineLimitTruncated ? 'maxLines' : undefined;

  let resultText = slicedLines.join('\n');

  if (Buffer.byteLength(resultText, 'utf8') > MAX_READ_FILE_BYTES) {
    resultText = truncateUtf8(resultText, MAX_READ_FILE_BYTES);
    truncationReason = 'maxBytes';
    slicedLines = resultText.split('\n');
  }

  const returnedLines = slicedLines.length;
  const truncated = truncationReason !== undefined;

  if (truncated) {
    resultText +=
      `\n[Truncated: ${truncationReason}; startLine=${startLine}; returnedLines=${returnedLines}; totalLines=${totalLines}]`;
  }

  return {
    content: [{ type: 'text', text: resultText }],
    details: {
      path: resolved.relativePath,
      startLine,
      returnedLines,
      totalLines,
      truncated,
      ...(truncationReason ? { truncationReason } : {}),
    },
    metadata: {
      trust: buildTrustMetadata({
        sourceKind: 'file',
        content: [{ type: 'text', text: resultText }],
        details: { path: resolved.relativePath },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// list_files executor
// ---------------------------------------------------------------------------

async function executeListFiles(
  worktreeAbsolute: string,
  _toolCallId: string,
  params: ListFilesParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<ListFilesDetails | ToolErrorDetails>> {
  const rootInputPath = params.path ?? '.';
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? MAX_LIST_FILES_RESULTS));

  const resolved = await resolveInsideWorktree(worktreeAbsolute, rootInputPath);
  if (resolved.kind === 'error') return makeError(resolved.code, resolved.message);

  const stat = await fsPromises.stat(resolved.absolutePath).catch(() => null);
  if (!stat) return makeError('not_found', `'${rootInputPath}' does not exist`);
  if (!stat.isDirectory()) {
    return makeError('not_a_directory', `'${rootInputPath}' is not a directory`);
  }

  let realWorktree: string;
  try {
    realWorktree = await fsPromises.realpath(worktreeAbsolute);
  } catch {
    realWorktree = worktreeAbsolute;
  }

  const globPattern = params.glob ?? '**';
  const entries: string[] = [];

  try {
    for await (const entry of nodeGlob(globPattern, {
      cwd: resolved.absolutePath,
      withFileTypes: true,
      follow: false,
    })) {
      if (signal?.aborted) break;
      if (entry.isDirectory()) continue;

      const absPath = path.join(entry.parentPath, entry.name);

      if (entry.isSymbolicLink()) {
        const inside = await symlinkIsInsideWorktree(absPath, realWorktree);
        if (!inside) continue;
      }

      const relFromWorktree = path.relative(realWorktree, absPath);
      entries.push(relFromWorktree);
    }
  } catch (err: unknown) {
    return makeError('io_error', `Error listing files: ${(err as Error).message}`);
  }

  // Sort before truncating so the returned subset is deterministic across runs
  // regardless of filesystem traversal order (REQ Determinism).
  entries.sort();
  const truncated = entries.length > maxResults;
  const returned = truncated ? entries.slice(0, maxResults) : entries;

  const text = returned.join('\n');

  return {
    content: [{ type: 'text', text }],
    details: {
      path: rootInputPath,
      glob: params.glob ?? null,
      count: returned.length,
      truncated,
      maxResults,
    },
    metadata: {
      trust: buildTrustMetadata({
        sourceKind: 'file',
        content: [{ type: 'text', text }],
        details: { path: rootInputPath, glob: params.glob ?? null },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// search_text executor
// ---------------------------------------------------------------------------

async function executeSearchText(
  worktreeAbsolute: string,
  _toolCallId: string,
  params: SearchTextParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<SearchTextDetails | ToolErrorDetails>> {
  if (!params.query || typeof params.query !== 'string') {
    return makeError('invalid_params', 'query must be a non-empty string');
  }

  const rootInputPath = params.path ?? '.';
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? MAX_SEARCH_TEXT_RESULTS));
  const caseSensitive = params.caseSensitive ?? false;

  const resolved = await resolveInsideWorktree(worktreeAbsolute, rootInputPath);
  if (resolved.kind === 'error') return makeError(resolved.code, resolved.message);

  const stat = await fsPromises.stat(resolved.absolutePath).catch(() => null);
  if (!stat) return makeError('not_found', `'${rootInputPath}' does not exist`);
  if (!stat.isDirectory()) {
    return makeError('not_a_directory', `'${rootInputPath}' is not a directory`);
  }

  const escapedQuery = params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const queryRegex = new RegExp(escapedQuery, caseSensitive ? '' : 'i');

  let realWorktree: string;
  try {
    realWorktree = await fsPromises.realpath(worktreeAbsolute);
  } catch {
    realWorktree = worktreeAbsolute;
  }

  const globPattern = params.glob ?? '**';
  const matchLines: string[] = [];
  let matchCount = 0;
  let truncated = false;

  try {
    for await (const entry of nodeGlob(globPattern, {
      cwd: resolved.absolutePath,
      withFileTypes: true,
      follow: false,
    })) {
      if (signal?.aborted || truncated) break;
      if (entry.isDirectory()) continue;

      const absPath = path.join(entry.parentPath, entry.name);

      if (entry.isSymbolicLink()) {
        const inside = await symlinkIsInsideWorktree(absPath, realWorktree);
        if (!inside) continue;
      }

      let buf: Buffer;
      try {
        buf = await fsPromises.readFile(absPath);
      } catch {
        continue;
      }

      if (looksLikeBinary(buf)) continue;

      const fileText = buf.toString('utf8');
      const lines = fileText.split('\n');
      const relPath = path.relative(realWorktree, absPath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!queryRegex.test(line)) continue;

        const displayLine =
          Buffer.byteLength(line, 'utf8') > MAX_SEARCH_LINE_BYTES
            ? truncateUtf8(line, MAX_SEARCH_LINE_BYTES) + ' [line truncated]'
            : line;

        matchLines.push(`${relPath}:${i + 1}: ${displayLine}`);
        matchCount++;

        if (matchCount >= maxResults) {
          truncated = true;
          break;
        }
      }
    }
  } catch (err: unknown) {
    return makeError('io_error', `Error searching files: ${(err as Error).message}`);
  }

  let text = matchLines.join('\n');
  if (truncated) {
    text += `\n[Truncated: maxResults=${maxResults}; ${matchCount} matches returned]`;
  }

  return {
    content: [{ type: 'text', text }],
    details: {
      query: params.query,
      path: rootInputPath,
      glob: params.glob ?? null,
      caseSensitive,
      matchCount,
      truncated,
      maxResults,
    },
    metadata: {
      trust: buildTrustMetadata({
        sourceKind: 'file',
        content: [{ type: 'text', text }],
        details: { query: params.query, path: rootInputPath, glob: params.glob ?? null },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// JSON Schema definitions
// ---------------------------------------------------------------------------

const READ_FILE_SCHEMA = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string', description: 'Path to the file, relative to the worktree root.' },
    startLine: {
      type: 'integer',
      minimum: 1,
      description: 'First line to return (1-indexed, default 1).',
    },
    maxLines: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum number of lines to return.',
    },
  },
  additionalProperties: false,
};

const LIST_FILES_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Directory path relative to the worktree root (default: worktree root).',
    },
    glob: {
      type: 'string',
      description: "Glob pattern to filter results (e.g. '**/*.ts').",
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Maximum number of entries to return (default 1000).',
    },
  },
  additionalProperties: false,
};

const SEARCH_TEXT_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'Literal string to search for.' },
    path: {
      type: 'string',
      description: 'Directory to search in, relative to the worktree root (default: worktree root).',
    },
    glob: {
      type: 'string',
      description: 'Glob pattern to filter which files are searched.',
    },
    caseSensitive: {
      type: 'boolean',
      description: 'Use case-sensitive matching (default: false).',
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'Maximum number of matches to return (default 200).',
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the three read-only file tool descriptors bound to a specific worktree.
 *
 * Pass the result to createToolRegistry() or register each descriptor
 * individually.
 */
export function createReadOnlyTools(worktreePath: string): ToolDescriptor[] {
  const absWorktree = path.resolve(worktreePath);

  return [
    {
      metadata: {
        name: 'read_file',
        description:
          'Read the contents of a file within the worktree. Supports line windowing via startLine and maxLines. Output is capped at 256 KB; truncation metadata is included when the cap is reached.',
        class: 'read-only',
        allowedPhases: ['planning', 'coding', 'review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxBytes: MAX_READ_FILE_BYTES },
      },
      parameters: READ_FILE_SCHEMA,
      async execute(toolCallId, params, signal) {
        return executeReadFile(absWorktree, toolCallId, params as ReadFileParams, signal);
      },
    } as ToolDescriptor<ReadFileParams, ReadFileDetails | ToolErrorDetails>,

    {
      metadata: {
        name: 'list_files',
        description:
          'List files within the worktree. Optionally scoped to a subdirectory and filtered by glob pattern. Returns one relative path per line in deterministic order. Capped at maxResults entries.',
        class: 'read-only',
        allowedPhases: ['planning', 'coding', 'review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxItems: MAX_LIST_FILES_RESULTS },
      },
      parameters: LIST_FILES_SCHEMA,
      async execute(toolCallId, params, signal) {
        return executeListFiles(absWorktree, toolCallId, params as ListFilesParams, signal);
      },
    } as ToolDescriptor<ListFilesParams, ListFilesDetails | ToolErrorDetails>,

    {
      metadata: {
        name: 'search_text',
        description:
          'Search for a literal string across files in the worktree. Returns matches in file:line: text format (like grep). Optionally scoped by path and glob pattern. Capped at maxResults matches.',
        class: 'read-only',
        allowedPhases: ['planning', 'coding', 'review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxItems: MAX_SEARCH_TEXT_RESULTS },
      },
      parameters: SEARCH_TEXT_SCHEMA,
      async execute(toolCallId, params, signal) {
        return executeSearchText(absWorktree, toolCallId, params as SearchTextParams, signal);
      },
    } as ToolDescriptor<SearchTextParams, SearchTextDetails | ToolErrorDetails>,
  ];
}

// ---------------------------------------------------------------------------
// Path field config for policies.ts beforeToolCall enforcement
// ---------------------------------------------------------------------------

/**
 * Path field names per tool for use with ToolPolicyConfig.pathFieldsByTool.
 *
 * Include this in the policy config so beforeToolCall can reject obvious
 * outside-worktree paths before execution even reaches the tool.
 */
export const READ_ONLY_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['path'],
  list_files: ['path'],
  search_text: ['path'],
};

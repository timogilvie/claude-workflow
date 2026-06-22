import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_READ_BYTES = 200_000;
const DEFAULT_MAX_LIST_RESULTS = 5_000;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const DEFAULT_MAX_SEARCH_BYTES = 100_000;

/**
 * Path fields for each tool — pass to toolPolicy.config.pathFieldsByTool so
 * beforeToolCall performs lexical boundary checks before execution.
 */
export const READ_ONLY_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['path'],
  list_files: ['path'],
  search_text: ['path'],
};

// ---------------------------------------------------------------------------
// Detail types
// ---------------------------------------------------------------------------

export interface ReadFileDetails {
  tool: 'read_file';
  path: string;
  resolvedPath: string;
  startLine: number;
  linesRequested: number | null;
  linesReturned: number;
  totalLines: number;
  originalBytes: number;
  retainedBytes: number;
  truncatedByBytes: boolean;
}

export interface ListFilesDetails {
  tool: 'list_files';
  path: string;
  glob: string | null;
  totalFound: number;
  returned: number;
  truncated: boolean;
}

export interface SearchTextDetails {
  tool: 'search_text';
  query: string;
  path: string;
  glob: string | null;
  caseSensitive: boolean;
  totalMatches: number;
  returned: number;
  truncatedByResults: boolean;
  truncatedByBytes: boolean;
}

export interface ToolErrorDetails {
  tool: string;
  errorKind:
    | 'path_outside_worktree'
    | 'symlink_escape'
    | 'file_not_found'
    | 'not_a_file'
    | 'not_a_directory'
    | 'permission_denied'
    | 'invalid_input';
  message: string;
  path?: string;
}

interface WalkEntry {
  relativePath: string;
  absolutePath: string;
  kind: 'file' | 'directory';
}

// ---------------------------------------------------------------------------
// Path safety helpers
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateUtf8Safe(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

function normalizeGlobPattern(pattern: string): string {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalized.replace(/\/+/g, '/');
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPattern(pattern);
  let source = '^';

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === '*') {
      if (next === '*') {
        const nextAfterGlobstar = normalized[i + 2];
        if (nextAfterGlobstar === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegex(char);
  }

  source += '$';
  return new RegExp(source);
}

async function walkEntries(rootPath: string, resolvedRoot: string, signal?: AbortSignal): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    if (signal?.aborted) break;

    const currentDir = stack.pop();
    if (!currentDir) break;

    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    dirEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirEntry of dirEntries) {
      if (signal?.aborted) break;
      if (dirEntry.isSymbolicLink()) continue;

      const absolutePath = path.join(currentDir, dirEntry.name);
      if (!isInsideWorktree(resolvedRoot, absolutePath)) continue;

      const relativePath = path.relative(resolvedRoot, absolutePath);
      if (dirEntry.isDirectory()) {
        entries.push({ relativePath, absolutePath, kind: 'directory' });
        stack.push(absolutePath);
        continue;
      }
      if (dirEntry.isFile()) {
        entries.push({ relativePath, absolutePath, kind: 'file' });
      }
    }
  }

  return entries;
}

function filterEntriesByGlob(entries: readonly WalkEntry[], pattern: string): WalkEntry[] {
  const matcher = globToRegExp(pattern);
  return entries.filter((entry) => matcher.test(entry.relativePath.replace(/\\/g, '/')));
}

function isInsideWorktree(resolvedRoot: string, resolvedCandidate: string): boolean {
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface PathValidationOk {
  ok: true;
  absolutePath: string;
  /** Resolved (symlink-followed) worktree root — use for all path.relative calls. */
  resolvedRoot: string;
}
interface PathValidationErr {
  ok: false;
  errorKind: ToolErrorDetails['errorKind'];
  message: string;
}
type PathValidationResult = PathValidationOk | PathValidationErr;

/**
 * Validate a candidate path against the worktree root with two layers:
 * 1. Lexical check — catches clear traversal like `../` before any fs access.
 * 2. Realpath check — catches symlink escapes after filesystem resolution.
 *    Also resolves the worktree root itself to handle OS symlinks (e.g. /var → /private/var on macOS).
 */
async function validatePath(worktreeRoot: string, candidatePath: string): Promise<PathValidationResult> {
  const normalized = candidatePath.replace(/\\/g, '/');
  const absoluteRaw = path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(worktreeRoot, normalized);

  // Layer 1: lexical check against the raw (un-resolved) worktree root.
  // Catches clear traversals early without any filesystem access.
  if (!isInsideWorktree(worktreeRoot, absoluteRaw)) {
    return {
      ok: false,
      errorKind: 'path_outside_worktree',
      message: `path_outside_worktree: '${candidatePath}' resolves outside the worktree`,
    };
  }

  // Layer 2: resolve both root and candidate to catch OS-level symlinks
  // (e.g. /var/folders → /private/var/folders on macOS) and symlink escapes.
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(worktreeRoot);
  } catch {
    resolvedRoot = worktreeRoot;
  }

  let realAbsolute: string;
  try {
    realAbsolute = await realpath(absoluteRaw);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, errorKind: 'file_not_found', message: `file_not_found: '${candidatePath}' does not exist` };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, errorKind: 'permission_denied', message: `permission_denied: cannot access '${candidatePath}'` };
    }
    return { ok: false, errorKind: 'permission_denied', message: `cannot access '${candidatePath}': ${String(err)}` };
  }

  if (!isInsideWorktree(resolvedRoot, realAbsolute)) {
    return {
      ok: false,
      errorKind: 'symlink_escape',
      message: `symlink_escape: '${candidatePath}' resolves via symlink to '${realAbsolute}' outside the worktree`,
    };
  }

  return { ok: true, absolutePath: realAbsolute, resolvedRoot };
}

function makeErrorResult(
  tool: string,
  details: ToolErrorDetails,
): WavemillToolResult<ToolErrorDetails> {
  return {
    content: [{ type: 'text', text: details.message }],
    details,
  };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

interface ReadFileParams {
  path: string;
  startLine?: number;
  maxLines?: number;
}

async function executeReadFile(
  worktreeRoot: string,
  _toolCallId: string,
  params: ReadFileParams,
): Promise<WavemillToolResult<ReadFileDetails | ToolErrorDetails>> {
  const validation = await validatePath(worktreeRoot, params.path);
  if (!validation.ok) {
    return makeErrorResult('read_file', {
      tool: 'read_file',
      errorKind: validation.errorKind,
      message: validation.message,
      path: params.path,
    });
  }

  const { absolutePath } = validation;

  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return makeErrorResult('read_file', {
      tool: 'read_file',
      errorKind: code === 'ENOENT' ? 'file_not_found' : 'permission_denied',
      message: `cannot access '${params.path}': ${String(err)}`,
      path: params.path,
    });
  }

  if (!fileStat.isFile()) {
    return makeErrorResult('read_file', {
      tool: 'read_file',
      errorKind: 'not_a_file',
      message: `not_a_file: '${params.path}' is not a regular file`,
      path: params.path,
    });
  }

  let rawContent: Buffer;
  try {
    rawContent = await readFile(absolutePath);
  } catch (err: unknown) {
    return makeErrorResult('read_file', {
      tool: 'read_file',
      errorKind: 'permission_denied',
      message: `cannot read '${params.path}': ${String(err)}`,
      path: params.path,
    });
  }

  const fullText = rawContent.toString('utf8');
  const allLines = fullText.split('\n');
  const totalLines = allLines.length;

  // 1-indexed; clamp to valid range
  const startLine = Math.max(1, params.startLine ?? 1);
  const startIdx = startLine - 1;
  const endIdx =
    params.maxLines !== undefined ? Math.min(startIdx + params.maxLines, totalLines) : totalLines;
  const selectedLines = allLines.slice(startIdx, endIdx);
  const linesReturned = selectedLines.length;

  let resultText = selectedLines.join('\n');
  const originalBytes = byteLength(resultText);
  const truncatedByBytes = originalBytes > DEFAULT_MAX_READ_BYTES;

  if (truncatedByBytes) {
    resultText = truncateUtf8Safe(resultText, DEFAULT_MAX_READ_BYTES);
    resultText += `\n[read_file: output truncated; originalBytes=${originalBytes}; retainedBytes=${byteLength(resultText)}]`;
  }

  const retainedBytes = byteLength(resultText);

  return {
    content: [{ type: 'text', text: resultText }],
    details: {
      tool: 'read_file',
      path: params.path,
      resolvedPath: absolutePath,
      startLine,
      linesRequested: params.maxLines ?? null,
      linesReturned,
      totalLines,
      originalBytes,
      retainedBytes,
      truncatedByBytes,
    } satisfies ReadFileDetails,
  };
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

interface ListFilesParams {
  path?: string;
  glob?: string;
  maxResults?: number;
}

async function executeListFiles(
  worktreeRoot: string,
  _toolCallId: string,
  params: ListFilesParams,
): Promise<WavemillToolResult<ListFilesDetails | ToolErrorDetails>> {
  const searchPath = params.path ?? '.';
  const maxResults = params.maxResults ?? DEFAULT_MAX_LIST_RESULTS;

  const validation = await validatePath(worktreeRoot, searchPath);
  if (!validation.ok) {
    return makeErrorResult('list_files', {
      tool: 'list_files',
      errorKind: validation.errorKind,
      message: validation.message,
      path: searchPath,
    });
  }

  const { absolutePath, resolvedRoot } = validation;

  let dirStat;
  try {
    dirStat = await stat(absolutePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return makeErrorResult('list_files', {
      tool: 'list_files',
      errorKind: code === 'ENOENT' ? 'file_not_found' : 'permission_denied',
      message: `cannot access '${searchPath}': ${String(err)}`,
      path: searchPath,
    });
  }

  if (!dirStat.isDirectory()) {
    return makeErrorResult('list_files', {
      tool: 'list_files',
      errorKind: 'not_a_directory',
      message: `not_a_directory: '${searchPath}' is not a directory`,
      path: searchPath,
    });
  }

  const allPaths: string[] = [];

  try {
    const walkedEntries = await walkEntries(absolutePath, resolvedRoot);

    if (params.glob !== undefined) {
      for (const entry of filterEntriesByGlob(walkedEntries, params.glob)) {
        allPaths.push(entry.relativePath);
      }
    } else {
      for (const entry of walkedEntries) {
        allPaths.push(entry.relativePath);
      }
    }
  } catch (err: unknown) {
    return makeErrorResult('list_files', {
      tool: 'list_files',
      errorKind: 'permission_denied',
      message: `error listing '${searchPath}': ${String(err)}`,
      path: searchPath,
    });
  }

  const totalFound = allPaths.length;
  const truncated = totalFound > maxResults;
  const returned = allPaths.slice(0, maxResults);

  return {
    content: [{ type: 'text', text: returned.join('\n') }],
    details: {
      tool: 'list_files',
      path: searchPath,
      glob: params.glob ?? null,
      totalFound,
      returned: returned.length,
      truncated,
    } satisfies ListFilesDetails,
  };
}

// ---------------------------------------------------------------------------
// search_text
// ---------------------------------------------------------------------------

interface SearchTextParams {
  query: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

async function collectFilesToSearch(
  absolutePath: string,
  resolvedRoot: string,
  globPattern: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const walkedEntries = await walkEntries(absolutePath, resolvedRoot, signal);
  const scopedEntries =
    globPattern !== undefined ? filterEntriesByGlob(walkedEntries, globPattern) : walkedEntries;
  return scopedEntries.filter((entry) => entry.kind === 'file').map((entry) => entry.absolutePath);
}

async function executeSearchText(
  worktreeRoot: string,
  _toolCallId: string,
  params: SearchTextParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<SearchTextDetails | ToolErrorDetails>> {
  const searchPath = params.path ?? '.';
  const caseSensitive = params.caseSensitive ?? false;
  const maxResults = params.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS;

  if (!params.query) {
    return makeErrorResult('search_text', {
      tool: 'search_text',
      errorKind: 'invalid_input',
      message: 'invalid_input: query must not be empty',
    });
  }

  const validation = await validatePath(worktreeRoot, searchPath);
  if (!validation.ok) {
    return makeErrorResult('search_text', {
      tool: 'search_text',
      errorKind: validation.errorKind,
      message: validation.message,
      path: searchPath,
    });
  }

  const { absolutePath, resolvedRoot } = validation;

  let dirStat;
  try {
    dirStat = await stat(absolutePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return makeErrorResult('search_text', {
      tool: 'search_text',
      errorKind: code === 'ENOENT' ? 'file_not_found' : 'permission_denied',
      message: `cannot access '${searchPath}': ${String(err)}`,
      path: searchPath,
    });
  }

  if (!dirStat.isDirectory()) {
    return makeErrorResult('search_text', {
      tool: 'search_text',
      errorKind: 'not_a_directory',
      message: `not_a_directory: '${searchPath}' is not a directory`,
      path: searchPath,
    });
  }

  let filesToSearch: string[];
  try {
    filesToSearch = await collectFilesToSearch(absolutePath, resolvedRoot, params.glob, signal);
  } catch (err: unknown) {
    return makeErrorResult('search_text', {
      tool: 'search_text',
      errorKind: 'permission_denied',
      message: `error collecting files to search: ${String(err)}`,
      path: searchPath,
    });
  }

  const query = caseSensitive ? params.query : params.query.toLowerCase();
  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  let truncatedByResults = false;

  for (const filePath of filesToSearch) {
    if (signal?.aborted || truncatedByResults) break;

    let fileContent: string;
    try {
      fileContent = (await readFile(filePath)).toString('utf8');
    } catch {
      continue;
    }

    const lines = fileContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (haystack.includes(query)) {
        totalMatches++;
        if (matches.length < maxResults) {
          matches.push({ file: path.relative(resolvedRoot, filePath), line: i + 1, text: line });
        } else {
          truncatedByResults = true;
          break;
        }
      }
    }
  }

  let resultText = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n');
  const originalBytes = byteLength(resultText);
  let truncatedByBytes = false;

  if (originalBytes > DEFAULT_MAX_SEARCH_BYTES) {
    truncatedByBytes = true;
    const truncated = truncateUtf8Safe(resultText, DEFAULT_MAX_SEARCH_BYTES);
    resultText = truncated + `\n[search_text: output truncated; originalBytes=${originalBytes}; retainedBytes=${byteLength(truncated)}]`;
  }

  return {
    content: [{ type: 'text', text: resultText || '(no matches)' }],
    details: {
      tool: 'search_text',
      query: params.query,
      path: searchPath,
      glob: params.glob ?? null,
      caseSensitive,
      totalMatches,
      returned: matches.length,
      truncatedByResults,
      truncatedByBytes,
    } satisfies SearchTextDetails,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create ToolDescriptors for the three read-only filesystem tools.
 *
 * Call this with the worktree root absolute path. Pair with READ_ONLY_PATH_FIELDS
 * in toolPolicy.config.pathFieldsByTool so beforeToolCall performs lexical checks:
 *
 *   toolPolicy: {
 *     phase,
 *     worktreePath: worktreeRoot,
 *     registry: [...createReadOnlyTools(worktreeRoot).map(d => d.metadata)],
 *     config: { pathFieldsByTool: READ_ONLY_PATH_FIELDS },
 *   }
 */
export function createReadOnlyTools(worktreeRoot: string): ToolDescriptor[] {
  const root = path.resolve(worktreeRoot);

  return [
    {
      metadata: {
        name: 'read_file',
        description:
          'Read the contents of a file in the worktree. Supports optional line-range selection.',
        class: 'read-only',
        allowedPhases: ['planning', 'coding', 'review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_READ_BYTES },
      },
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'File path relative to the worktree root.' },
          startLine: {
            type: 'integer',
            minimum: 1,
            description: 'First line to return (1-indexed). Default: 1.',
          },
          maxLines: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum number of lines to return.',
          },
        },
      },
      async execute(toolCallId, params) {
        return executeReadFile(root, toolCallId, params as ReadFileParams);
      },
    },
    {
      metadata: {
        name: 'list_files',
        description:
          'List files and directories in the worktree, optionally filtered by a glob pattern.',
        class: 'read-only',
        allowedPhases: ['planning', 'coding', 'review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxItems: DEFAULT_MAX_LIST_RESULTS },
      },
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory to list, relative to the worktree root. Default: root.',
          },
          glob: {
            type: 'string',
            description: 'Glob pattern to filter results (e.g. "**/*.ts"). Default: all entries.',
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            description: `Maximum entries to return. Default: ${DEFAULT_MAX_LIST_RESULTS}.`,
          },
        },
      },
      async execute(toolCallId, params) {
        return executeListFiles(root, toolCallId, params as ListFilesParams);
      },
    },
    {
      metadata: {
        name: 'search_text',
        description: 'Search for text within files in the worktree and return matching lines.',
        class: 'read-only',
        allowedPhases: ['planning', 'coding', 'review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_SEARCH_BYTES },
      },
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Text to search for.' },
          path: {
            type: 'string',
            description: 'Directory to search in, relative to the worktree root. Default: root.',
          },
          glob: {
            type: 'string',
            description: 'Glob pattern to restrict which files are searched (e.g. "**/*.ts").',
          },
          caseSensitive: {
            type: 'boolean',
            description: 'Whether the search is case-sensitive. Default: false.',
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            description: `Maximum matches to return. Default: ${DEFAULT_MAX_SEARCH_RESULTS}.`,
          },
        },
      },
      async execute(toolCallId, params, signal) {
        return executeSearchText(root, toolCallId, params as SearchTextParams, signal);
      },
    },
  ];
}

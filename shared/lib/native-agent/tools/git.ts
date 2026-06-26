import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ToolPolicyConfig } from './policies.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

const DEFAULT_DIFF_MAX_BYTES = 64 * 1024;
const MIN_DIFF_MAX_BYTES = 1;
const DEFAULT_LOG_COUNT = 20;
const MAX_LOG_COUNT = 100;

type GitToolName = 'git_status' | 'git_diff' | 'git_diff_stat' | 'git_log';

export interface GitStatusParams {}

export interface GitDiffParams {
  base?: string;
  path?: string;
  maxBytes?: number;
}

export interface GitDiffStatParams {
  base?: string;
  path?: string;
  maxBytes?: number;
}

export interface GitLogParams {
  maxCount?: number;
  base?: string;
}

export interface GitFileStatus {
  path: string;
  indexStatus?: string;
  worktreeStatus?: string;
  originalPath?: string;
}

export interface GitBranchStatus {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
}

export interface GitStatusSuccessDetails {
  ok: true;
  tool: 'git_status';
  repoRoot: string;
  branch: GitBranchStatus;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
  unmerged: GitFileStatus[];
  ignored: GitFileStatus[];
  isClean: boolean;
}

export interface GitDiffSuccessDetails {
  ok: true;
  tool: 'git_diff';
  repoRoot: string;
  base: string | null;
  path: string | null;
  maxBytes: number;
  diff: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export interface GitDiffStatFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitDiffStatSuccessDetails {
  ok: true;
  tool: 'git_diff_stat';
  repoRoot: string;
  base: string;
  path: string | null;
  maxBytes: number;
  files: GitDiffStatFile[];
  filesChanged: number;
  additions: number;
  deletions: number;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export interface GitLogCommit {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitLogSuccessDetails {
  ok: true;
  tool: 'git_log';
  repoRoot: string;
  base: string | null;
  maxCount: number;
  count: number;
  commits: GitLogCommit[];
}

export interface GitToolErrorDetails {
  ok: false;
  tool: GitToolName;
  error: {
    code: 'invalid_input' | 'not_git_repository' | 'git_failed' | 'aborted';
    message: string;
    stderr: string;
    exitCode: number | null;
    args: string[];
  };
}

export type GitStatusDetails = GitStatusSuccessDetails | GitToolErrorDetails;
export type GitDiffDetails = GitDiffSuccessDetails | GitToolErrorDetails;
export type GitDiffStatDetails = GitDiffStatSuccessDetails | GitToolErrorDetails;
export type GitLogDetails = GitLogSuccessDetails | GitToolErrorDetails;
type GitToolDetails = GitStatusDetails | GitDiffDetails | GitDiffStatDetails | GitLogDetails;

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitAfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

interface GitAfterToolCallResult {
  isError?: boolean;
}

interface ParsedBranchState {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
}

const gitStatusParameters = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const gitDiffParameters = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    path: { type: 'string' },
    maxBytes: { type: 'integer', minimum: MIN_DIFF_MAX_BYTES },
  },
  additionalProperties: false,
};

const gitDiffStatParameters = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    path: { type: 'string' },
    maxBytes: { type: 'integer', minimum: MIN_DIFF_MAX_BYTES },
  },
  additionalProperties: false,
};

const gitLogParameters = {
  type: 'object',
  properties: {
    maxCount: { type: 'integer', minimum: 1 },
    base: { type: 'string' },
  },
  additionalProperties: false,
};

export const gitToolPolicyConfig: ToolPolicyConfig = {
  pathFieldsByTool: { git_diff: ['path'], git_diff_stat: ['path'] },
};

export function createGitTools(worktreePath: string): readonly ToolDescriptor[] {
  return [
    createGitStatusTool(worktreePath),
    createGitDiffTool(worktreePath),
    createGitDiffStatTool(worktreePath),
    createGitLogTool(worktreePath),
  ];
}

export function createGitStatusTool(worktreePath: string): ToolDescriptor<GitStatusParams, GitStatusDetails> {
  return {
    metadata: {
      name: 'git_status',
      description: 'Inspect the current git worktree status without modifying repository state.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: gitStatusParameters,
    async execute(_toolCallId, _params, signal) {
      return runGitStatus(worktreePath, signal);
    },
  };
}

export function createGitDiffTool(worktreePath: string): ToolDescriptor<GitDiffParams, GitDiffDetails> {
  return {
    metadata: {
      name: 'git_diff',
      description: 'Inspect the current git diff, optionally against a base ref or limited to a path.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_DIFF_MAX_BYTES },
    },
    parameters: gitDiffParameters,
    async execute(_toolCallId, params, signal) {
      return runGitDiff(worktreePath, params, signal);
    },
  };
}

export function createGitDiffStatTool(
  worktreePath: string,
): ToolDescriptor<GitDiffStatParams, GitDiffStatDetails> {
  return {
    metadata: {
      name: 'git_diff_stat',
      description: 'Inspect structured git diff statistics, optionally against a base ref or limited to a path.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_DIFF_MAX_BYTES },
    },
    parameters: gitDiffStatParameters,
    async execute(_toolCallId, params, signal) {
      return runGitDiffStat(worktreePath, params, signal);
    },
  };
}

export function createGitLogTool(worktreePath: string): ToolDescriptor<GitLogParams, GitLogDetails> {
  return {
    metadata: {
      name: 'git_log',
      description: 'Inspect recent commits from the current worktree history without traversing unrelated refs.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: gitLogParameters,
    async execute(_toolCallId, params, signal) {
      return runGitLog(worktreePath, params, signal);
    },
  };
}

export async function gitAfterToolCall(
  context: GitAfterToolCallContext,
): Promise<GitAfterToolCallResult | undefined> {
  if (
    context.toolCall.name !== 'git_status' &&
    context.toolCall.name !== 'git_diff' &&
    context.toolCall.name !== 'git_diff_stat' &&
    context.toolCall.name !== 'git_log'
  ) {
    return undefined;
  }
  const details = context.result.details as GitToolDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  if (details.ok) {
    return undefined;
  }
  return { isError: true };
}

async function runGitStatus(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitStatusDetails>> {
  const repoRoot = await resolveRepoRoot(worktreePath, 'git_status', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const status = await runGit(repoRoot.repoRoot, ['status', '--porcelain=v2', '--branch', '-z'], signal);
  if (!status.ok) {
    return errorResult('git_status', ['status', '--porcelain=v2', '--branch', '-z'], status);
  }

  const details = parseGitStatusOutput(repoRoot.repoRoot, status.stdout);
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

async function runGitDiff(
  worktreePath: string,
  params: GitDiffParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitDiffDetails>> {
  const validatedBase = validateRevisionInput('git_diff', params.base);
  if (!validatedBase.ok) return validatedBase.result;
  const validatedPath = validatePathInput('git_diff', params.path);
  if (!validatedPath.ok) return validatedPath.result;
  if (params.maxBytes !== undefined && (!Number.isInteger(params.maxBytes) || params.maxBytes < MIN_DIFF_MAX_BYTES)) {
    return invalidInputResult('git_diff', `maxBytes must be an integer >= ${MIN_DIFF_MAX_BYTES}`);
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_diff', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const maxBytes = params.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const gitArgs = ['diff', '--no-ext-diff', '--no-color'];
  const compareBase = validatedBase.value ?? 'HEAD';
  gitArgs.push(compareBase);

  const scopedPath = normalizeGitPath(repoRoot.repoRoot, validatedPath.value);
  if (scopedPath !== undefined) {
    gitArgs.push('--', scopedPath);
  }

  const diff = await runGit(repoRoot.repoRoot, gitArgs, signal);
  if (!diff.ok) {
    return errorResult('git_diff', gitArgs, diff);
  }

  const originalBytes = Buffer.byteLength(diff.stdout, 'utf8');
  const retainedDiff = truncateUtf8(diff.stdout, maxBytes);
  const retainedBytes = Buffer.byteLength(retainedDiff, 'utf8');
  const details: GitDiffSuccessDetails = {
    ok: true,
    tool: 'git_diff',
    repoRoot: repoRoot.repoRoot,
    base: compareBase,
    path: scopedPath ?? null,
    maxBytes,
    diff: retainedDiff,
    originalBytes,
    retainedBytes,
    truncated: originalBytes > retainedBytes,
  };

  return {
    content: [{ type: 'text', text: retainedDiff }],
    details,
  };
}

async function runGitDiffStat(
  worktreePath: string,
  params: GitDiffStatParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitDiffStatDetails>> {
  const validatedBase = validateRevisionInput('git_diff_stat', params.base);
  if (!validatedBase.ok) return validatedBase.result;
  const validatedPath = validatePathInput('git_diff_stat', params.path);
  if (!validatedPath.ok) return validatedPath.result;
  if (params.maxBytes !== undefined && (!Number.isInteger(params.maxBytes) || params.maxBytes < MIN_DIFF_MAX_BYTES)) {
    return invalidInputResult('git_diff_stat', `maxBytes must be an integer >= ${MIN_DIFF_MAX_BYTES}`);
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_diff_stat', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const maxBytes = params.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const compareBase = validatedBase.value ?? 'HEAD';
  const gitArgs = ['diff', '--no-ext-diff', '--no-color', '--numstat', compareBase];
  const scopedPath = normalizeGitPath(repoRoot.repoRoot, validatedPath.value);
  if (scopedPath !== undefined) {
    gitArgs.push('--', scopedPath);
  }

  const diffStat = await runGit(repoRoot.repoRoot, gitArgs, signal);
  if (!diffStat.ok) {
    return errorResult('git_diff_stat', gitArgs, diffStat);
  }

  const originalBytes = Buffer.byteLength(diffStat.stdout, 'utf8');
  const retainedOutput = truncateUtf8(diffStat.stdout, maxBytes);
  const retainedBytes = Buffer.byteLength(retainedOutput, 'utf8');
  const parsed = parseGitDiffStatOutput(retainedOutput);
  const details: GitDiffStatSuccessDetails = {
    ok: true,
    tool: 'git_diff_stat',
    repoRoot: repoRoot.repoRoot,
    base: compareBase,
    path: scopedPath ?? null,
    maxBytes,
    files: parsed.files,
    filesChanged: parsed.files.length,
    additions: parsed.additions,
    deletions: parsed.deletions,
    originalBytes,
    retainedBytes,
    truncated: originalBytes > retainedBytes,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

async function runGitLog(
  worktreePath: string,
  params: GitLogParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<GitLogDetails>> {
  const validatedBase = validateRevisionInput('git_log', params.base);
  if (!validatedBase.ok) return validatedBase.result;
  if (params.maxCount !== undefined && (!Number.isInteger(params.maxCount) || params.maxCount < 1)) {
    return invalidInputResult('git_log', 'maxCount must be an integer >= 1');
  }

  const repoRoot = await resolveRepoRoot(worktreePath, 'git_log', signal);
  if (!repoRoot.ok) {
    return repoRoot.result;
  }

  const maxCount = Math.min(params.maxCount ?? DEFAULT_LOG_COUNT, MAX_LOG_COUNT);
  const gitArgs = [
    'log',
    '--no-color',
    '-z',
    '-n',
    String(maxCount),
    '--format=%H%x00%an%x00%ae%x00%aI%x00%s',
  ];
  if (validatedBase.value !== undefined) {
    gitArgs.push(validatedBase.value);
  }

  const log = await runGit(repoRoot.repoRoot, gitArgs, signal);
  if (!log.ok) {
    return errorResult('git_log', gitArgs, log);
  }

  const commits = parseGitLogOutput(log.stdout);
  const details: GitLogSuccessDetails = {
    ok: true,
    tool: 'git_log',
    repoRoot: repoRoot.repoRoot,
    base: validatedBase.value ?? null,
    maxCount,
    count: commits.length,
    commits,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

async function resolveRepoRoot(
  worktreePath: string,
  tool: GitToolName,
  signal?: AbortSignal,
): Promise<
  | { ok: true; repoRoot: string }
  | { ok: false; result: WavemillToolResult<GitToolErrorDetails> }
> {
  const args = ['rev-parse', '--show-toplevel'];
  const probe = await runGit(worktreePath, args, signal);
  if (!probe.ok) {
    return { ok: false, result: errorResult(tool, args, probe) };
  }
  return { ok: true, repoRoot: probe.stdout.trim() };
}

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<
  | ({ ok: true } & GitCommandResult)
  | ({ ok: false; code: GitToolErrorDetails['error']['code'] } & Partial<GitCommandResult>)
> {
  const subcommand = args[0];
  if (subcommand !== 'rev-parse' && subcommand !== 'status' && subcommand !== 'diff' && subcommand !== 'log') {
    return {
      ok: false,
      code: 'invalid_input',
      stderr: `git subcommand "${subcommand}" is not allowed`,
      exitCode: null,
    };
  }

  try {
    const result = await spawnGit(cwd, args, signal);
    return { ok: true, ...result };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, code: 'aborted', stderr: 'git command aborted', exitCode: null };
    }
    const err = error as NodeJS.ErrnoException & Partial<GitCommandResult>;
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.message;
    const exitCode = typeof err.exitCode === 'number' ? err.exitCode : 1;
    return {
      ok: false,
      code: /not a git repository/i.test(stderr) ? 'not_git_repository' : 'git_failed',
      stderr,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      exitCode,
    };
  }
}

async function spawnGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      const error = new Error(stderr || `git ${args[0]} failed with exit code ${code}`) as Error &
        NodeJS.ErrnoException &
        Partial<GitCommandResult>;
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}

function parseGitStatusOutput(repoRoot: string, output: string): GitStatusSuccessDetails {
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const branch: ParsedBranchState = {
    oid: null,
    head: null,
    upstream: null,
    detached: false,
    ahead: 0,
    behind: 0,
  };
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  const untracked: GitFileStatus[] = [];
  const unmerged: GitFileStatus[] = [];
  const ignored: GitFileStatus[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith('# ')) {
      parseBranchToken(branch, token.slice(2));
      continue;
    }
    if (token.startsWith('? ')) {
      untracked.push({ path: token.slice(2) });
      continue;
    }
    if (token.startsWith('! ')) {
      ignored.push({ path: token.slice(2) });
      continue;
    }
    if (token.startsWith('1 ')) {
      const entry = parseTrackedEntry(token);
      if (entry.indexStatus && entry.indexStatus !== '.') staged.push(entry);
      if (entry.worktreeStatus && entry.worktreeStatus !== '.') unstaged.push(entry);
      continue;
    }
    if (token.startsWith('2 ')) {
      const entry = parseRenamedEntry(token, tokens[index + 1] ?? '');
      index += 1;
      if (entry.indexStatus && entry.indexStatus !== '.') staged.push(entry);
      if (entry.worktreeStatus && entry.worktreeStatus !== '.') unstaged.push(entry);
      continue;
    }
    if (token.startsWith('u ')) {
      unmerged.push(parseUnmergedEntry(token));
    }
  }

  return {
    ok: true,
    tool: 'git_status',
    repoRoot,
    branch,
    staged,
    unstaged,
    untracked,
    unmerged,
    ignored,
    isClean:
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0 &&
      unmerged.length === 0,
  };
}

function parseBranchToken(branch: ParsedBranchState, token: string): void {
  if (token.startsWith('branch.oid ')) {
    const oid = token.slice('branch.oid '.length);
    branch.oid = oid === '(initial)' ? null : oid;
    return;
  }
  if (token.startsWith('branch.head ')) {
    const head = token.slice('branch.head '.length);
    branch.detached = head === '(detached)';
    branch.head = branch.detached ? null : head;
    return;
  }
  if (token.startsWith('branch.upstream ')) {
    branch.upstream = token.slice('branch.upstream '.length);
    return;
  }
  if (token.startsWith('branch.ab ')) {
    const match = /^branch\.ab \+(\d+) -(\d+)$/.exec(token);
    if (match) {
      branch.ahead = Number.parseInt(match[1]!, 10);
      branch.behind = Number.parseInt(match[2]!, 10);
    }
  }
}

function parseTrackedEntry(token: string): GitFileStatus {
  const parts = token.split(' ');
  return {
    path: parts.slice(8).join(' '),
    indexStatus: parts[1]?.[0],
    worktreeStatus: parts[1]?.[1],
  };
}

function parseRenamedEntry(token: string, originalPath: string): GitFileStatus {
  const parts = token.split(' ');
  return {
    path: parts.slice(9).join(' '),
    originalPath,
    indexStatus: parts[1]?.[0],
    worktreeStatus: parts[1]?.[1],
  };
}

function parseUnmergedEntry(token: string): GitFileStatus {
  const parts = token.split(' ');
  return {
    path: parts.slice(10).join(' '),
    indexStatus: parts[1]?.[0],
    worktreeStatus: parts[1]?.[1],
  };
}

function parseGitDiffStatOutput(output: string): {
  files: GitDiffStatFile[];
  additions: number;
  deletions: number;
} {
  const files: GitDiffStatFile[] = [];
  let additions = 0;
  let deletions = 0;

  for (const line of output.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 3) {
      continue;
    }
    const [rawAdditions, rawDeletions, ...pathParts] = parts;
    const filePath = pathParts.join('\t');
    const binary = rawAdditions === '-' || rawDeletions === '-';
    const fileAdditions = binary ? null : Number.parseInt(rawAdditions, 10);
    const fileDeletions = binary ? null : Number.parseInt(rawDeletions, 10);
    if (fileAdditions !== null && Number.isFinite(fileAdditions)) {
      additions += fileAdditions;
    }
    if (fileDeletions !== null && Number.isFinite(fileDeletions)) {
      deletions += fileDeletions;
    }
    files.push({
      path: filePath,
      additions: Number.isFinite(fileAdditions ?? NaN) ? fileAdditions : null,
      deletions: Number.isFinite(fileDeletions ?? NaN) ? fileDeletions : null,
      binary,
    });
  }

  return { files, additions, deletions };
}

function parseGitLogOutput(output: string): GitLogCommit[] {
  const tokens = output.split('\0').filter((token, index, allTokens) => token !== '' || index < allTokens.length - 1);
  const commits: GitLogCommit[] = [];

  for (let index = 0; index + 4 < tokens.length; index += 5) {
    const hash = tokens[index];
    const author = tokens[index + 1];
    const email = tokens[index + 2];
    const date = tokens[index + 3];
    const subject = tokens[index + 4];
    if (!hash || author === undefined || email === undefined || date === undefined || subject === undefined) {
      continue;
    }
    commits.push({ hash, author, email, date, subject });
  }

  return commits;
}

function errorResult(
  tool: GitToolName,
  args: string[],
  result: { code: GitToolErrorDetails['error']['code']; stderr?: string; exitCode?: number | null },
): WavemillToolResult<GitToolErrorDetails> {
  const message = formatErrorMessage(tool, result.code, result.stderr ?? '');
  return {
    content: [{ type: 'text', text: message }],
    details: {
      ok: false,
      tool,
      error: {
        code: result.code,
        message,
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? null,
        args,
      },
    },
  };
}

function invalidInputResult(
  tool: GitToolName,
  message: string,
): WavemillToolResult<GitToolErrorDetails> {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      ok: false,
      tool,
      error: {
        code: 'invalid_input',
        message,
        stderr: '',
        exitCode: null,
        args: [],
      },
    },
  };
}

function formatErrorMessage(
  tool: GitToolName,
  code: GitToolErrorDetails['error']['code'],
  stderr: string,
): string {
  if (code === 'not_git_repository') {
    return stderr || `${tool} requires a git repository`;
  }
  if (code === 'aborted') {
    return `${tool} aborted`;
  }
  if (stderr !== '') {
    return stderr;
  }
  return `${tool} failed`;
}

function normalizeGitPath(repoRoot: string, toolPath: string | undefined): string | undefined {
  if (toolPath === undefined) {
    return undefined;
  }
  const comparable = toolPath.replace(/\\/g, '/');
  const absolute = path.resolve(repoRoot, comparable);
  const relative = path.relative(repoRoot, absolute).replace(/\\/g, '/');
  return relative === '' ? '.' : relative;
}

const REVISION_SHELL_METACHARACTERS = /[;&|<>`$()\\{}*?"'\[\]!#]/;

function validatePathInput(
  tool: GitToolName,
  rawPath: string | undefined,
): { ok: true; value: string | undefined } | { ok: false; result: WavemillToolResult<GitToolErrorDetails> } {
  if (rawPath === undefined) {
    return { ok: true, value: undefined };
  }
  if (rawPath.includes('\u0000')) {
    return { ok: false, result: invalidInputResult(tool, 'path must not contain NUL bytes') };
  }
  if (rawPath.startsWith('-')) {
    return { ok: false, result: invalidInputResult(tool, 'path must not begin with "-"') };
  }
  return { ok: true, value: rawPath };
}

function validateRevisionInput(
  tool: GitToolName,
  rawBase: string | undefined,
): { ok: true; value: string | undefined } | { ok: false; result: WavemillToolResult<GitToolErrorDetails> } {
  if (rawBase === undefined) {
    return { ok: true, value: undefined };
  }

  if (rawBase.includes('\u0000')) {
    return { ok: false, result: invalidInputResult(tool, 'base must not contain NUL bytes') };
  }

  const base = rawBase.trim();
  if (base === '') {
    return { ok: false, result: invalidInputResult(tool, 'base must be a non-empty string') };
  }
  if (base.startsWith('-')) {
    return { ok: false, result: invalidInputResult(tool, 'base must not begin with "-"') };
  }
  if (/\s/.test(base)) {
    return { ok: false, result: invalidInputResult(tool, 'base must not contain whitespace') };
  }
  if (base.includes('..')) {
    return { ok: false, result: invalidInputResult(tool, 'base must not contain ".." range syntax') };
  }
  if (REVISION_SHELL_METACHARACTERS.test(base)) {
    return { ok: false, result: invalidInputResult(tool, 'base must not contain shell metacharacters') };
  }

  return { ok: true, value: base };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
}

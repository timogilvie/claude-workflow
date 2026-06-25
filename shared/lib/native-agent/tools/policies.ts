import path from 'node:path';
import {
  validateWholeFileWriteAllowlistInput,
  type WholeFileWriteAllowlistInput,
} from '../coding-artifacts.ts';
import { matchesAnyPattern } from '../../permission-patterns.ts';
import type { ToolMetadata, ToolPhase } from './types.ts';

export type ToolPolicyReason = 'phase_denied' | 'path_denied' | 'write_denied';

export interface ToolPolicyConfig {
  readOnlyPhases?: readonly ToolPhase[];
  pathFieldsByTool?: Readonly<Record<string, readonly string[]>>;
  wholeFileWriteAllowlist?: WholeFileWriteAllowlistInput;
}

export interface ToolPolicyCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolPolicyInput {
  phase: ToolPhase;
  config?: ToolPolicyConfig;
  worktreePath: string;
  registry: readonly ToolMetadata[];
  toolCall: ToolPolicyCall;
}

export interface ToolPolicyAllowDecision {
  kind: 'allow';
}

export interface ToolPolicyDenyDecision {
  kind: 'deny';
  reason: ToolPolicyReason;
  message: string;
}

export type ToolPolicyDecision = ToolPolicyAllowDecision | ToolPolicyDenyDecision;

const ALLOW: ToolPolicyAllowDecision = { kind: 'allow' };
const DEFAULT_READ_ONLY_PHASES: readonly ToolPhase[] = ['planning', 'review'];

export function evaluateBeforeToolCallPolicy(input: ToolPolicyInput): ToolPolicyDecision {
  const worktreeRoot = normalizeWorktreeRoot(input.worktreePath);
  const metadata = input.registry.find((tool) => tool.name === input.toolCall.name);

  if (isReadOnlyPhase(input.phase, input.config)) {
    if (!metadata || metadata.class !== 'read-only' || !metadata.allowedPhases.includes(input.phase)) {
      return deny(
        'phase_denied',
        `phase_denied: tool "${input.toolCall.name}" is not allowed in ${input.phase}`,
      );
    }
  }

  const pathFields = input.config?.pathFieldsByTool?.[input.toolCall.name] ?? [];
  for (const field of pathFields) {
    for (const candidate of getConfiguredPaths(input.toolCall, field)) {
      const resolved = resolveCandidatePath(worktreeRoot, candidate);
      if (resolved.kind === 'outside') {
        return deny(
          'path_denied',
          `path_denied: '${resolved.displayPath}' resolves outside the worktree`,
        );
      }
    }
  }

  if (metadata?.class === 'mutation') {
    const decision = evaluateMutationPolicy(worktreeRoot, input.toolCall, input.config);
    if (decision) {
      return decision;
    }
  }

  return ALLOW;
}

function deny(reason: ToolPolicyReason, message: string): ToolPolicyDenyDecision {
  return { kind: 'deny', reason, message };
}

function isReadOnlyPhase(phase: ToolPhase, config: ToolPolicyConfig | undefined): boolean {
  return (config?.readOnlyPhases ?? DEFAULT_READ_ONLY_PHASES).includes(phase);
}

function normalizeWorktreeRoot(worktreePath: string): string {
  if (worktreePath.trim() === '') {
    throw new Error('Tool policy requires a non-empty worktreePath');
  }
  return path.posix.resolve('/', toComparablePath(worktreePath));
}

function getConfiguredPaths(toolCall: ToolPolicyCall, field: string): string[] {
  const value = toolCall.arguments[field];
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  throw new Error(
    `Tool policy path field "${field}" for "${toolCall.name}" must be a string or string[]`,
  );
}

function resolveCandidatePath(
  worktreeRoot: string,
  candidatePath: string,
): { kind: 'inside'; displayPath: string; repoRelativePath: string } | { kind: 'outside'; displayPath: string } {
  const comparable = toComparablePath(candidatePath);
  const displayPath = toDisplayPath(candidatePath);
  const absoluteCandidate = path.posix.isAbsolute(comparable)
    ? path.posix.normalize(comparable)
    : path.posix.resolve(worktreeRoot, comparable);
  const relativePath = path.posix.relative(worktreeRoot, absoluteCandidate);

  if (
    relativePath === '' ||
    (!relativePath.startsWith('../') && relativePath !== '..' && !path.posix.isAbsolute(relativePath))
  ) {
    return {
      kind: 'inside',
      displayPath,
      repoRelativePath: relativePath === '' ? '.' : relativePath,
    };
  }

  return { kind: 'outside', displayPath };
}

function evaluateMutationPolicy(
  worktreeRoot: string,
  toolCall: ToolPolicyCall,
  config: ToolPolicyConfig | undefined,
): ToolPolicyDecision | null {
  const pathValue = getMutationTargetPath(toolCall);
  if (!pathValue) {
    return null;
  }

  const resolved = resolveCandidatePath(worktreeRoot, pathValue);
  if (resolved.kind === 'outside') {
    return deny(
      'path_denied',
      `path_denied: '${resolved.displayPath}' resolves outside the worktree`,
    );
  }

  if (!isWholeFileWrite(toolCall)) {
    return null;
  }

  if (!isSourceLikePath(resolved.repoRelativePath) || isAllowlistedWholeFilePath(resolved.repoRelativePath, config)) {
    return null;
  }

  return deny(
    'write_denied',
    `write_denied: whole-file source writes require a generated or Wavemill-owned allowlist path (${resolved.displayPath})`,
  );
}

function isWholeFileWrite(toolCall: ToolPolicyCall): boolean {
  switch (toolCall.name) {
    case 'write_file':
    case 'write_artifact':
    case 'create_marker':
      return true;
    case 'patch_file':
      return typeof toolCall.arguments.content === 'string'
        && !hasStructuredPatchPayload(toolCall.arguments);
    default:
      return false;
  }
}

function hasStructuredPatchPayload(args: Record<string, unknown>): boolean {
  return [
    'patch',
    'diff',
    'oldText',
    'newText',
    'operations',
    'edits',
  ].some((key) => key in args);
}

function getMutationTargetPath(toolCall: ToolPolicyCall): string | null {
  for (const key of ['path', 'filePath', 'targetPath']) {
    const value = toolCall.arguments[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return null;
}

function isAllowlistedWholeFilePath(repoRelativePath: string, config: ToolPolicyConfig | undefined): boolean {
  const input = config?.wholeFileWriteAllowlist;
  if (!input) {
    return false;
  }

  const result = validateWholeFileWriteAllowlistInput(input);
  if (!result.ok) {
    throw new Error(result.errors[0]?.message ?? 'Whole-file write allowlist is invalid');
  }

  return matchesAnyPattern(repoRelativePath, result.value.generatedPaths)
    || matchesAnyPattern(repoRelativePath, result.value.wavemillOwnedPaths);
}

const SOURCE_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
  '.zsh',
]);

const SOURCE_LIKE_BASENAMES = new Set([
  'Dockerfile',
  'Makefile',
  'Justfile',
]);

function isSourceLikePath(repoRelativePath: string): boolean {
  const base = path.posix.basename(repoRelativePath);
  if (SOURCE_LIKE_BASENAMES.has(base)) {
    return true;
  }
  return SOURCE_FILE_EXTENSIONS.has(path.posix.extname(base));
}

function toComparablePath(rawPath: string): string {
  const normalizedSeparators = rawPath.replace(/\\/g, '/');
  const driveQualified = /^[A-Za-z]:($|\/)/.test(normalizedSeparators)
    ? `/${normalizedSeparators}`
    : normalizedSeparators;
  return path.posix.normalize(driveQualified);
}

function toDisplayPath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
  return normalized === '' ? '.' : normalized;
}

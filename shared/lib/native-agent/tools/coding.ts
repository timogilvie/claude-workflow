import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

import type { WholeFileWriteAllowlistInput } from '../coding-artifacts.ts';
import { evaluateMutationWritePolicy } from '../mutation-policy.ts';
import { validateNativePatch, type NativePatchValidationError } from '../patch-contract.ts';
import { applyNativePatch } from '../patch-runtime.ts';
import { redactSecrets } from './redaction.ts';
import { resolveInsideWorktree } from './read-only.ts';
import type { ToolPolicyConfig } from './policies.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

const APPLY_PATCH_SCHEMA = {
  type: 'object',
  required: ['version', 'atomic', 'operations'],
  properties: {
    version: { type: 'integer' },
    atomic: { const: true },
    operations: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['op', 'path'],
        properties: {
          op: { type: 'string', enum: ['edit', 'edit-diff'] },
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
          diff: { type: 'string' },
          anchorBefore: { type: 'string' },
          anchorAfter: { type: 'string' },
          expectedOccurrences: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
        allOf: [
          {
            if: { properties: { op: { const: 'edit' } } },
            then: { required: ['oldText', 'newText'] },
          },
          {
            if: { properties: { op: { const: 'edit-diff' } } },
            then: { required: ['diff'] },
          },
        ],
      },
    },
    fuzzyMatch: {
      type: 'object',
      properties: {
        minSimilarity: { type: 'number', minimum: 0, maximum: 1 },
        maxMatchCandidates: { type: 'integer', minimum: 1 },
        maxContextLines: { type: 'integer', minimum: 0 },
        ignoreWhitespace: { type: 'boolean' },
        requireAnchorOverlap: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const WRITE_ARTIFACT_SCHEMA = {
  type: 'object',
  required: ['path', 'content'],
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const CREATE_MARKER_SCHEMA = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const UPDATE_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' },
    detail: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export interface ApplyPatchSuccessDetails {
  ok: true;
  appliedOperations: number;
  changedFiles: Array<{ path: string; linesAdded: number; linesRemoved: number }>;
  linesAdded: number;
  linesRemoved: number;
}

export interface ApplyPatchInvalidDetails {
  ok: false;
  code: 'invalid_patch';
  errors: NativePatchValidationError[];
}

export interface ApplyPatchRejectedDetails {
  ok: false;
  rejection: Awaited<ReturnType<typeof applyNativePatch>> extends infer TResult
    ? TResult extends { ok: false; rejection: infer TRejection }
      ? TRejection
      : never
    : never;
  retryHint: string;
}

export type ApplyPatchDetails =
  | ApplyPatchSuccessDetails
  | ApplyPatchInvalidDetails
  | ApplyPatchRejectedDetails;

export interface WholeFileWriteSuccessDetails {
  ok: true;
  path: string;
  bytesWritten: number;
}

export interface WholeFileWriteErrorDetails {
  ok: false;
  code: 'path_denied' | 'whole_file_source_write_denied' | 'invalid_params';
  message: string;
}

export type WriteArtifactDetails = WholeFileWriteSuccessDetails | WholeFileWriteErrorDetails;
export type CreateMarkerDetails = WholeFileWriteSuccessDetails | WholeFileWriteErrorDetails;

export interface UpdateStatusSuccessDetails {
  ok: true;
  status: string;
  timestamp: number;
}

export interface UpdateStatusErrorDetails {
  ok: false;
  code: 'invalid_params';
  message: string;
}

export type UpdateStatusDetails = UpdateStatusSuccessDetails | UpdateStatusErrorDetails;

interface CodingAfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

export const CODING_TOOL_NAMES = ['apply_patch', 'write_artifact', 'create_marker', 'update_status'] as const;
const CODING_TOOL_NAME_SET = new Set<string>(CODING_TOOL_NAMES);

export const codingToolPolicyConfig: ToolPolicyConfig = {
  pathFieldsByTool: {
    write_artifact: ['path'],
    create_marker: ['path'],
  },
};

export function createCodingTools(
  worktreePath: string,
  allowlist?: WholeFileWriteAllowlistInput,
): ToolDescriptor[] {
  return [
    createApplyPatchTool(worktreePath),
    createWriteArtifactTool(worktreePath, allowlist),
    createCreateMarkerTool(worktreePath, allowlist),
    createUpdateStatusTool(worktreePath),
  ];
}

export function createApplyPatchTool(worktreePath: string): ToolDescriptor<unknown, ApplyPatchDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'apply_patch',
      description: 'Apply an atomic native patch to one or more files inside the active worktree.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: APPLY_PATCH_SCHEMA,
    async execute(_toolCallId, params, _signal) {
      const validated = validateNativePatch(params);
      if (!validated.ok) {
        return {
          content: [{ type: 'text', text: formatInvalidPatchSummary(validated.errors) }],
          details: { ok: false, code: 'invalid_patch', errors: validated.errors },
        };
      }

      const result = await applyNativePatch(absWorktree, validated.value, { phase: 'coding' });
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: formatPatchRejectionSummary(result.rejection) }],
          details: {
            ok: false,
            rejection: result.rejection,
            retryHint: result.rejection.hint,
          },
        };
      }

      const details: ApplyPatchSuccessDetails = {
        ok: true,
        appliedOperations: result.appliedOperations,
        changedFiles: result.fileChanges,
        linesAdded: result.linesAdded,
        linesRemoved: result.linesRemoved,
      };

      return {
        content: [{ type: 'text', text: formatPatchSuccessSummary(details) }],
        details,
      };
    },
  };
}

export function createWriteArtifactTool(
  worktreePath: string,
  allowlist?: WholeFileWriteAllowlistInput,
): ToolDescriptor<unknown, WriteArtifactDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'write_artifact',
      description: 'Write an allowlisted artifact file inside the active worktree.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: WRITE_ARTIFACT_SCHEMA,
    async execute(_toolCallId, params, _signal) {
      return executeWholeFileWrite(absWorktree, 'write_artifact', params, allowlist);
    },
  };
}

export function createCreateMarkerTool(
  worktreePath: string,
  allowlist?: WholeFileWriteAllowlistInput,
): ToolDescriptor<unknown, CreateMarkerDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'create_marker',
      description: 'Create an allowlisted marker file inside the active worktree, optionally with content.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: CREATE_MARKER_SCHEMA,
    async execute(_toolCallId, params, _signal) {
      return executeWholeFileWrite(absWorktree, 'create_marker', params, allowlist);
    },
  };
}

export function createUpdateStatusTool(worktreePath: string): ToolDescriptor<unknown, UpdateStatusDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'update_status',
      description: 'Persist a durable coding-phase status update in the worktree-local native status log.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: UPDATE_STATUS_SCHEMA,
    async execute(_toolCallId, params, _signal) {
      return executeUpdateStatus(absWorktree, params);
    },
  };
}

export async function codingAfterToolCall(
  context: CodingAfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (!CODING_TOOL_NAME_SET.has(context.toolCall.name)) {
    return undefined;
  }
  const details = context.result.details;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  if ((details as { ok: boolean }).ok) {
    return undefined;
  }
  return { isError: true };
}

async function executeWholeFileWrite(
  worktreePath: string,
  toolName: 'write_artifact' | 'create_marker',
  params: unknown,
  allowlist?: WholeFileWriteAllowlistInput,
): Promise<WavemillToolResult<WriteArtifactDetails | CreateMarkerDetails>> {
  const parsed = parseWholeFileWriteParams(toolName, params);
  if (!parsed.ok) {
    return parsed.result;
  }

  const decision = evaluateMutationWritePolicy({
    worktreePath,
    targetPath: parsed.path,
    writeKind: 'whole-file',
    wholeFileAllowlist: allowlist ?? {},
  });

  if (decision.kind === 'deny') {
    return errorResult(decision.reason, decision.message);
  }

  const resolved = await resolveWriteTargetInsideWorktree(worktreePath, decision.resolvedPath);
  if (!resolved.ok) {
    return errorResult('path_denied', resolved.message);
  }

  mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
  writeFileSync(resolved.absolutePath, parsed.content, 'utf8');

  const details: WholeFileWriteSuccessDetails = {
    ok: true,
    path: decision.resolvedPath,
    bytesWritten: Buffer.byteLength(parsed.content, 'utf8'),
  };

  return {
    content: [{ type: 'text', text: `${toolName} wrote ${details.path} (${details.bytesWritten} bytes)` }],
    details,
  };
}

async function resolveWriteTargetInsideWorktree(
  worktreePath: string,
  relativePath: string,
): Promise<{ ok: true; absolutePath: string } | { ok: false; message: string }> {
  const normalized = relativePath.replace(/\\/g, '/');
  const existingAncestor = await resolveExistingAncestor(worktreePath, normalized);
  if (!existingAncestor.ok) {
    return existingAncestor;
  }

  const remainingRelative = existingAncestor.relativeDir === '.'
    ? normalized
    : path.relative(existingAncestor.relativeDir, normalized);
  return {
    ok: true,
    absolutePath: path.resolve(existingAncestor.absolutePath, remainingRelative),
  };
}

async function resolveExistingAncestor(
  worktreePath: string,
  relativePath: string,
): Promise<
  | { ok: true; absolutePath: string; relativeDir: string }
  | { ok: false; message: string }
> {
  let candidateDir = path.dirname(relativePath);
  while (true) {
    const probePath = candidateDir === '.' ? '.' : candidateDir;
    const resolved = await resolveInsideWorktree(worktreePath, probePath);
    if (resolved.kind === 'ok') {
      return { ok: true, absolutePath: resolved.absolutePath, relativeDir: resolved.relativePath };
    }
    if (resolved.code !== 'not_found') {
      return { ok: false, message: resolved.message };
    }
    if (candidateDir === '.' || candidateDir === path.dirname(candidateDir)) {
      return { ok: false, message: `'${relativePath}' resolves outside the worktree` };
    }
    candidateDir = path.dirname(candidateDir);
  }
}

function executeUpdateStatus(
  worktreePath: string,
  params: unknown,
): WavemillToolResult<UpdateStatusDetails> {
  if (!isRecord(params) || typeof params.status !== 'string' || params.status.trim() === '') {
    return {
      content: [{ type: 'text', text: 'update_status requires a non-empty status string.' }],
      details: {
        ok: false,
        code: 'invalid_params',
        message: 'status must be a non-empty string',
      },
    };
  }

  if (params.detail !== undefined && typeof params.detail !== 'string') {
    return {
      content: [{ type: 'text', text: 'update_status detail must be a string when provided.' }],
      details: {
        ok: false,
        code: 'invalid_params',
        message: 'detail must be a string when provided',
      },
    };
  }

  const timestamp = Date.now();
  const redactedDetail = typeof params.detail === 'string'
    ? redactSecrets(params.detail, { placeholder: '[REDACTED]' }).text
    : undefined;
  const statusRecord = {
    status: params.status,
    ...(redactedDetail !== undefined ? { detail: redactedDetail } : {}),
    timestamp,
  };
  const statusPath = path.join(worktreePath, '.wavemill', 'native-coding-status.jsonl');
  mkdirSync(path.dirname(statusPath), { recursive: true });
  appendFileSync(statusPath, `${JSON.stringify(statusRecord)}\n`, 'utf8');

  return {
    content: [{ type: 'text', text: `status recorded: ${params.status}` }],
    details: { ok: true, status: params.status, timestamp },
  };
}

function parseWholeFileWriteParams(
  toolName: 'write_artifact' | 'create_marker',
  params: unknown,
): {
  ok: true;
  path: string;
  content: string;
} | {
  ok: false;
  result: WavemillToolResult<WholeFileWriteErrorDetails>;
} {
  if (!isRecord(params) || typeof params.path !== 'string' || params.path.trim() === '') {
    return {
      ok: false,
      result: errorResult('invalid_params', `${toolName} requires a non-empty path string.`),
    };
  }

  const contentValue = params.content;
  if (toolName === 'write_artifact') {
    if (typeof contentValue !== 'string') {
      return {
        ok: false,
        result: errorResult('invalid_params', 'write_artifact requires a string content field.'),
      };
    }
  } else if (contentValue !== undefined && typeof contentValue !== 'string') {
    return {
      ok: false,
      result: errorResult('invalid_params', 'create_marker content must be a string when provided.'),
    };
  }

  return {
    ok: true,
    path: params.path,
    content: typeof contentValue === 'string' ? contentValue : '',
  };
}

function formatInvalidPatchSummary(errors: NativePatchValidationError[]): string {
  const first = errors[0];
  return `apply_patch rejected invalid patch (${errors.length} issue${errors.length === 1 ? '' : 's'}): ${first?.message ?? 'unknown validation error'}`;
}

function formatPatchRejectionSummary(rejection: ApplyPatchRejectedDetails['rejection']): string {
  return `apply_patch rejected operation ${rejection.operationIndex}: ${rejection.code}. ${rejection.hint}`;
}

function formatPatchSuccessSummary(details: ApplyPatchSuccessDetails): string {
  const fileSummary = details.changedFiles
    .map((file) => `${file.path} (+${file.linesAdded}/-${file.linesRemoved})`)
    .join(', ');
  return `apply_patch applied ${details.appliedOperations} operation${details.appliedOperations === 1 ? '' : 's'} across ${details.changedFiles.length} file${details.changedFiles.length === 1 ? '' : 's'}: ${fileSummary}`;
}

function errorResult(
  code: WholeFileWriteErrorDetails['code'],
  message: string,
): WavemillToolResult<WholeFileWriteErrorDetails> {
  return {
    content: [{ type: 'text', text: message }],
    details: { ok: false, code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

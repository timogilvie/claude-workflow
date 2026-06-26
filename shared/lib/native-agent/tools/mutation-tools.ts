import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  evaluateMutationWritePolicy,
  type MutationPolicyReason,
} from '../mutation-policy.ts';
import type {
  NormalizedWholeFileWriteAllowlistInput,
  WholeFileWriteAllowlistInput,
} from '../coding-artifacts.ts';
import { createApplyPatchTool } from './apply-patch-tool.ts';
import type { ToolDescriptor, ToolPhase, WavemillToolResult } from './types.ts';
import type { ApplyPatchDetails } from './apply-patch-tool.ts';

const DEFAULT_WHOLE_FILE_ALLOWLIST: NormalizedWholeFileWriteAllowlistInput = {
  generatedPaths: ['.wavemill/**'],
  wavemillOwnedPaths: ['features/**', 'bugs/**'],
};

const STATUS_STATES = ['working', 'idle', 'waiting', 'error'] as const;

type StatusState = (typeof STATUS_STATES)[number];
type MutationToolName = 'write_artifact' | 'create_marker' | 'update_status';

export interface WriteArtifactParams {
  path: string;
  content: string;
}

export interface CreateMarkerParams {
  path: string;
  content?: string;
}

export interface UpdateStatusParams {
  state: StatusState;
  message?: string;
  detail?: string;
}

export interface WholeFileWriteSuccessDetails {
  ok: true;
  tool: 'write_artifact' | 'create_marker';
  resolvedPath: string;
  bytesWritten: number;
}

export interface StatusSuccessDetails {
  ok: true;
  tool: 'update_status';
  state: StatusState;
  message?: string;
  detail?: string;
  statusPath: string;
}

export interface MutationToolErrorDetails {
  ok: false;
  tool: MutationToolName | 'apply_patch';
  error: 'invalid_input' | MutationPolicyReason | 'io_error';
  message: string;
  retryHint?: string;
  diagnostics?: unknown;
}

export type WriteArtifactDetails = WholeFileWriteSuccessDetails | MutationToolErrorDetails;
export type CreateMarkerDetails = WholeFileWriteSuccessDetails | MutationToolErrorDetails;
export type UpdateStatusDetails = StatusSuccessDetails | MutationToolErrorDetails;
export type CodingMutationDetails = ApplyPatchDetails | WriteArtifactDetails | CreateMarkerDetails | UpdateStatusDetails;

export interface CodingMutationToolOptions {
  phase?: ToolPhase;
  wholeFileAllowlist?: WholeFileWriteAllowlistInput | NormalizedWholeFileWriteAllowlistInput;
  statusPath?: string;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

const writeArtifactParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
};

const createMarkerParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path'],
  additionalProperties: false,
};

const updateStatusParameters = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: [...STATUS_STATES] },
    message: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['state'],
  additionalProperties: false,
};

export const codingMutationPolicyConfig = {
  pathFieldsByTool: {
    write_artifact: ['path'],
    create_marker: ['path'],
  },
} as const;

export function createCodingMutationTools(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): readonly ToolDescriptor[] {
  return [
    createApplyPatchTool(worktreePath, { phase: options.phase }),
    createWriteArtifactTool(worktreePath, options),
    createCreateMarkerTool(worktreePath, options),
    createUpdateStatusTool(worktreePath, options),
  ];
}

export function createWriteArtifactTool(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): ToolDescriptor<WriteArtifactParams, WriteArtifactDetails> {
  return {
    metadata: {
      name: 'write_artifact',
      description: 'Write a Wavemill-owned artifact file through the whole-file mutation policy.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: writeArtifactParameters,
    async execute(_toolCallId, params) {
      return executeWholeFileWrite('write_artifact', worktreePath, params.path, params.content, options);
    },
  };
}

export function createCreateMarkerTool(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): ToolDescriptor<CreateMarkerParams, CreateMarkerDetails> {
  return {
    metadata: {
      name: 'create_marker',
      description: 'Create a Wavemill-owned marker file through the whole-file mutation policy.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: createMarkerParameters,
    async execute(_toolCallId, params) {
      return executeWholeFileWrite('create_marker', worktreePath, params.path, params.content ?? '', options);
    },
  };
}

export function createUpdateStatusTool(
  worktreePath: string,
  options: CodingMutationToolOptions = {},
): ToolDescriptor<UpdateStatusParams, UpdateStatusDetails> {
  return {
    metadata: {
      name: 'update_status',
      description: 'Durably persist native coding status updates for transcript and orchestration consumers.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: updateStatusParameters,
    async execute(_toolCallId, params) {
      return executeUpdateStatus(worktreePath, params, options);
    },
  };
}

export async function codingMutationAfterToolCall(
  context: AfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (!['apply_patch', 'write_artifact', 'create_marker', 'update_status'].includes(context.toolCall.name)) {
    return undefined;
  }
  const details = context.result.details as CodingMutationDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

async function executeWholeFileWrite(
  tool: 'write_artifact' | 'create_marker',
  worktreePath: string,
  targetPath: string,
  content: string,
  options: CodingMutationToolOptions,
): Promise<WavemillToolResult<WriteArtifactDetails | CreateMarkerDetails>> {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return errorResult(tool, 'invalid_input', 'path must be a non-empty string');
  }
  if (typeof content !== 'string') {
    return errorResult(tool, 'invalid_input', 'content must be a string');
  }

  const decision = evaluateMutationWritePolicy({
    worktreePath,
    targetPath,
    writeKind: 'whole-file',
    wholeFileAllowlist: options.wholeFileAllowlist ?? DEFAULT_WHOLE_FILE_ALLOWLIST,
  });

  if (decision.kind === 'deny') {
    return deniedWriteResult(tool, decision.reason, decision.message);
  }

  const absolutePath = join(worktreePath, decision.resolvedPath);
  try {
    atomicWriteText(absolutePath, content);
    const details: WholeFileWriteSuccessDetails = {
      ok: true,
      tool,
      resolvedPath: decision.resolvedPath,
      bytesWritten: Buffer.byteLength(content, 'utf-8'),
    };
    return {
      content: [{ type: 'text', text: `${tool} wrote ${decision.resolvedPath}` }],
      details,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(tool, 'io_error', `Failed to write ${decision.resolvedPath}: ${message}`);
  }
}

async function executeUpdateStatus(
  worktreePath: string,
  params: UpdateStatusParams,
  options: CodingMutationToolOptions,
): Promise<WavemillToolResult<UpdateStatusDetails>> {
  if (!isStatusState(params.state)) {
    return errorResult('update_status', 'invalid_input', 'state must be one of: working, idle, waiting, error');
  }
  if (params.message !== undefined && typeof params.message !== 'string') {
    return errorResult('update_status', 'invalid_input', 'message must be a string when provided');
  }
  if (params.detail !== undefined && typeof params.detail !== 'string') {
    return errorResult('update_status', 'invalid_input', 'detail must be a string when provided');
  }

  const statusPath = options.statusPath ?? defaultStatusPath(worktreePath);
  const payload = buildStatusPayload(statusPath, params);
  try {
    atomicWriteText(statusPath, `${JSON.stringify(payload)}\n`);
    const details: StatusSuccessDetails = {
      ok: true,
      tool: 'update_status',
      state: params.state,
      ...(params.message !== undefined ? { message: params.message } : {}),
      ...(params.detail !== undefined ? { detail: params.detail } : {}),
      statusPath,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(details) }],
      details,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('update_status', 'io_error', `Failed to persist status: ${message}`);
  }
}

function buildStatusPayload(
  statusPath: string,
  params: UpdateStatusParams,
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    base = {};
  }
  return {
    ...base,
    state: params.state,
    event: 'update_status',
    agent: 'native',
    timestamp: Math.floor(Date.now() / 1000),
    ...(params.message !== undefined ? { message: params.message } : {}),
    ...(params.detail !== undefined ? { detail: params.detail } : {}),
  };
}

function deniedWriteResult(
  tool: 'write_artifact' | 'create_marker',
  error: MutationPolicyReason,
  message: string,
): WavemillToolResult<WriteArtifactDetails | CreateMarkerDetails> {
  const retryHint = error === 'whole_file_source_write_denied'
    ? 'use apply_patch for source edits'
    : 'write to a path inside the active worktree';
  return errorResult(tool, error, message, retryHint);
}

function errorResult(
  tool: MutationToolErrorDetails['tool'],
  error: MutationToolErrorDetails['error'],
  message: string,
  retryHint?: string,
): WavemillToolResult<any> {
  const details: MutationToolErrorDetails = {
    ok: false,
    tool,
    error,
    message,
    ...(retryHint !== undefined ? { retryHint } : {}),
  };
  return {
    content: [{ type: 'text', text: message }],
    details,
  };
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

function defaultStatusPath(worktreePath: string): string {
  const runDir = process.env.WAVEMILL_RUN_DIR;
  return runDir ? join(runDir, 'native-status.json') : join(worktreePath, '.wavemill', 'native-status.json');
}

function isStatusState(value: string): value is StatusState {
  return (STATUS_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Native command/test tool executors for the coding phase.
//
// Both tools wrap the shared command substrate and expose a consistent
// CommandDetails shape so transcript tool_result events contain the full
// approval/debug metadata required by the HOK-2353 acceptance criteria:
//
//   commandClass, approval, rejectionReason, cwd, exitCode, timedOut,
//   durationMs, truncated, retainedBytes, stdout, stderr.
//
// The loop's deriveOutputCapMetadata reads details.truncated and
// details.retainedBytes (same convention as git_diff's originalBytes /
// retainedBytes) to derive ToolOutputCapMetadata.
// ---------------------------------------------------------------------------

import { runCommand, type ApprovalOutcome, type RejectionReason } from '../command-substrate.ts';
import type { CommandClass } from '../command-classifier.ts';
import type { ToolDescriptor, ToolPhase, WavemillToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunCommandParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunTestsParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Structured details for a command execution result.
 *
 * Approved and rejected commands share the same shape so transcript consumers
 * can always read commandClass, approval, and cwd without branching.
 *
 * When approval === 'rejected', exitCode is null and stdout/stderr are empty
 * (no process was spawned). rejectionReason explains why.
 *
 * retainedBytes is the total UTF-8 byte length of the captured stdout + stderr
 * after truncation. It maps to the loop's deriveOutputCapMetadata retainedLength.
 */
export interface CommandDetails {
  commandClass: CommandClass;
  approval: ApprovalOutcome;
  rejectionReason?: RejectionReason | string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  retainedBytes: number;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Shared executor
// ---------------------------------------------------------------------------

async function executeCommand(
  toolCwd: string,
  params: RunCommandParams | RunTestsParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<CommandDetails>> {
  const command = typeof params.command === 'string' ? params.command : '';
  const cwd = params.cwd ?? toolCwd;
  const result = await runCommand({
    command,
    cwd,
    allowedRoots: [toolCwd],
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    shell: true,
    signal,
  });

  const retainedBytes =
    Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8');

  const details: CommandDetails = {
    commandClass: result.commandClass,
    approval: result.approval,
    ...(result.rejectionReason !== undefined ? { rejectionReason: result.rejectionReason } : {}),
    cwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    truncated: result.truncated,
    retainedBytes,
    stdout: result.stdout,
    stderr: result.stderr,
  };

  if (result.approval === 'rejected') {
    const reason = result.rejectionReason ?? 'unknown';
    return {
      content: [{ type: 'text', text: `Command rejected: ${reason}` }],
      details,
    };
  }

  const outputParts: string[] = [];
  if (result.stdout.length > 0) outputParts.push(result.stdout);
  if (result.stderr.length > 0) outputParts.push(result.stderr);
  const text = outputParts.join('\n') || '(no output)';

  return {
    content: [{ type: 'text', text }],
    details,
  };
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

const commandParameters = {
  type: 'object',
  required: ['command'],
  properties: {
    command: {
      type: 'string',
      description: 'Shell command to execute.',
    },
    cwd: {
      type: 'string',
      description: 'Working directory relative to the worktree root. Defaults to the worktree root.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum wall-clock milliseconds before SIGTERM. Default: 60 000.',
    },
    maxOutputBytes: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum combined stdout+stderr bytes to capture. Default: 262 144 (256 KB).',
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export interface CommandToolOptions {
  phase?: ToolPhase;
}

export function createRunCommandTool(
  worktreePath: string,
  options: CommandToolOptions = {},
): ToolDescriptor<RunCommandParams, CommandDetails> {
  const phase: ToolPhase = options.phase ?? 'coding';
  return {
    metadata: {
      name: 'run_command',
      description:
        'Execute a shell command (lint, build, etc.) in the worktree. ' +
        'Dangerous commands and paths outside the worktree are rejected. ' +
        'Output is capped at maxOutputBytes; truncation and approval metadata are included in the result.',
      class: 'mutation',
      allowedPhases: [phase],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_OUTPUT_BYTES },
    },
    parameters: commandParameters,
    async execute(_toolCallId, params, signal) {
      return executeCommand(worktreePath, params, signal);
    },
  };
}

export function createRunTestsTool(
  worktreePath: string,
  options: CommandToolOptions = {},
): ToolDescriptor<RunTestsParams, CommandDetails> {
  const phase: ToolPhase = options.phase ?? 'coding';
  return {
    metadata: {
      name: 'run_tests',
      description:
        'Execute a test suite command in the worktree. ' +
        'Dangerous commands and paths outside the worktree are rejected. ' +
        'Output is capped at maxOutputBytes; truncation and approval metadata are included in the result.',
      class: 'mutation',
      allowedPhases: [phase],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_OUTPUT_BYTES },
    },
    parameters: commandParameters,
    async execute(_toolCallId, params, signal) {
      return executeCommand(worktreePath, params, signal);
    },
  };
}

export function createCommandTools(
  worktreePath: string,
  options: CommandToolOptions = {},
): readonly ToolDescriptor[] {
  return [
    createRunCommandTool(worktreePath, options),
    createRunTestsTool(worktreePath, options),
  ];
}

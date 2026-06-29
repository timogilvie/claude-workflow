import { Buffer } from 'node:buffer';

import type { CommandClass } from '../command-classifier.ts';
import { classifyCommand } from '../command-classifier.ts';
import {
  runCommand,
  type ApprovalOutcome,
  type RejectionReason,
  type RunCommandOptions,
} from '../command-substrate.ts';
import type { CleanupTracker } from '../cleanup.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_FORMAT_TIMEOUT_MS = 60_000;
const INTERNAL_CAP_MULTIPLIER = 16;
const INTERNAL_CAP_FLOOR_BYTES = 1024 * 1024;
const SUBSTRATE_TRUNCATION_MARKER = '[output truncated]';

export type RunCommandKind = 'tests' | 'format';
export type RunCommandStatus = 'completed' | 'timed_out' | 'rejected';
export type RunCommandToolName = 'run_tests' | 'run_format';

export interface RunCommandParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunCommandOutputMeta {
  originalByteLength: number;
  truncated: boolean;
}

export interface RunCommandSuccessDetails {
  ok: true;
  tool: RunCommandToolName;
  kind: RunCommandKind;
  status: 'completed' | 'timed_out';
  commandClass: CommandClass;
  approval: ApprovalOutcome;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutMeta: RunCommandOutputMeta;
  stderrMeta: RunCommandOutputMeta;
  truncated: boolean;
}

export interface RunCommandRejectedDetails {
  ok: false;
  tool: RunCommandToolName;
  kind: RunCommandKind;
  status: 'rejected';
  error: 'unsafe_command' | 'cwd_outside_allowed_roots' | 'invalid_input';
  commandClass: CommandClass;
  reason: string;
  command: string;
  cwd: string;
  durationMs: number;
  message: string;
  retryHint?: string;
}

export type RunCommandDetails = RunCommandSuccessDetails | RunCommandRejectedDetails;

export interface CommandToolFactoryOptions {
  allowedEnvKeys?: readonly string[];
  spawnFn?: RunCommandOptions['spawnFn'];
  cleanupTracker?: CleanupTracker;
}

interface RunScopedCommandInput extends RunCommandParams {
  tool: RunCommandToolName;
  kind: RunCommandKind;
  worktreePath: string;
  defaultTimeoutMs: number;
  allowedEnvKeys?: readonly string[];
  spawnFn?: RunCommandOptions['spawnFn'];
  signal?: AbortSignal;
  cleanupTracker?: CleanupTracker;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

const runCommandParameters = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1 },
    cwd: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1 },
    maxOutputBytes: { type: 'integer', minimum: 1 },
  },
  required: ['command'],
  additionalProperties: false,
};

/**
 * Create the structured `run_tests` tool for the coding phase.
 *
 * Commands execute inside `worktreePath` or one of its subdirectories and return
 * capped stdout/stderr plus execution metadata. Output is middle-truncated per
 * stream so both the leading setup and trailing failure summary are retained when
 * the captured output exceeds the requested byte budget.
 */
export function createRunTestsTool(
  worktreePath: string,
  options: CommandToolFactoryOptions = {},
): ToolDescriptor<RunCommandParams, RunCommandDetails> {
  return {
    metadata: {
      name: 'run_tests',
      description:
        'Run the project test suite or a scoped subset inside the active worktree, returning capped output and structured execution metadata.',
      class: 'read-only',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_OUTPUT_BYTES },
    },
    parameters: runCommandParameters,
    async execute(_toolCallId, params, signal) {
      return runScopedCommand({
        ...params,
        tool: 'run_tests',
        kind: 'tests',
        worktreePath,
        defaultTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
        allowedEnvKeys: options.allowedEnvKeys,
        spawnFn: options.spawnFn,
        signal,
        cleanupTracker: options.cleanupTracker,
      });
    },
  };
}

/**
 * Create the structured `run_format` tool for the coding phase.
 *
 * This tool uses the same command substrate as `run_tests` but is marked as a
 * mutation tool because formatters are expected to rewrite files under the
 * worktree.
 */
export function createRunFormatTool(
  worktreePath: string,
  options: CommandToolFactoryOptions = {},
): ToolDescriptor<RunCommandParams, RunCommandDetails> {
  return {
    metadata: {
      name: 'run_format',
      description:
        'Run a formatter or other scoped code-style command inside the active worktree, returning capped output and structured execution metadata.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'truncate', maxBytes: DEFAULT_MAX_OUTPUT_BYTES },
    },
    parameters: runCommandParameters,
    async execute(_toolCallId, params, signal) {
      return runScopedCommand({
        ...params,
        tool: 'run_format',
        kind: 'format',
        worktreePath,
        defaultTimeoutMs: DEFAULT_FORMAT_TIMEOUT_MS,
        allowedEnvKeys: options.allowedEnvKeys,
        spawnFn: options.spawnFn,
        signal,
        cleanupTracker: options.cleanupTracker,
      });
    },
  };
}

/**
 * Create both structured command tools for a worktree.
 */
export function createCommandTools(
  worktreePath: string,
  options: CommandToolFactoryOptions = {},
): readonly ToolDescriptor<RunCommandParams, RunCommandDetails>[] {
  return [createRunTestsTool(worktreePath, options), createRunFormatTool(worktreePath, options)];
}

/**
 * Treat rejected command-tool calls as loop errors while allowing failing test
 * exits and timeouts to remain usable results.
 */
export async function commandToolsAfterToolCall(
  context: AfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (context.toolCall.name !== 'run_tests' && context.toolCall.name !== 'run_format') {
    return undefined;
  }

  const details = context.result.details as RunCommandDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

/**
 * Execute a scoped command through the native command substrate.
 *
 * `stdoutMeta.originalByteLength` and `stderrMeta.originalByteLength` describe
 * the bytes captured by the substrate before this wrapper's middle-truncation
 * pass. For extremely large output, the substrate may already have dropped the
 * true tail before this function sees it.
 */
export async function runScopedCommand(
  input: RunScopedCommandInput,
): Promise<WavemillToolResult<RunCommandDetails>> {
  const startedAt = Date.now();
  const normalizedCommand = typeof input.command === 'string' ? input.command.trim() : '';
  const commandClass = classifyCommand(normalizedCommand).commandClass;
  const effectiveCwd = input.cwd ?? input.worktreePath;

  if (typeof input.command !== 'string' || normalizedCommand.length === 0) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'empty-command',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: Date.now() - startedAt,
      message: 'command must be a non-empty string.',
      retryHint: 'Provide a concrete test or format command and retry.',
    });
  }

  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.trim().length === 0)) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'invalid-cwd',
      command: normalizedCommand,
      cwd: typeof input.cwd === 'string' ? input.cwd : input.worktreePath,
      durationMs: Date.now() - startedAt,
      message: 'cwd must be a non-empty string when provided.',
      retryHint: 'Use the worktree root or a subdirectory inside it.',
    });
  }

  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'invalid-timeout',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: Date.now() - startedAt,
      message: 'timeoutMs must be a positive integer.',
      retryHint: 'Use a positive integer timeout in milliseconds.',
    });
  }

  if (input.maxOutputBytes !== undefined && (!Number.isInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0)) {
    return rejectedResult({
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: 'invalid_input',
      commandClass,
      reason: 'invalid-max-output-bytes',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: Date.now() - startedAt,
      message: 'maxOutputBytes must be a positive integer.',
      retryHint: 'Use a positive integer byte limit.',
    });
  }

  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const result = await runCommand({
    command: normalizedCommand,
    cwd: effectiveCwd,
    allowedRoots: [input.worktreePath],
    timeoutMs: input.timeoutMs ?? input.defaultTimeoutMs,
    maxOutputBytes: internalCap(maxOutputBytes),
    allowedEnvKeys: input.allowedEnvKeys,
    spawnFn: input.spawnFn,
    signal: input.signal,
    onSpawn: (child) => input.cleanupTracker?.registerProcess(child),
  });

  if (result.approval === 'rejected') {
    const details: RunCommandRejectedDetails = {
      ok: false,
      tool: input.tool,
      kind: input.kind,
      status: 'rejected',
      error: mapRejectionToError(result.rejectionReason),
      commandClass: result.commandClass,
      reason: result.rejectionReason ?? 'command-rejected',
      command: normalizedCommand,
      cwd: effectiveCwd,
      durationMs: result.durationMs,
      message: rejectionMessage(result.rejectionReason),
      retryHint: rejectionRetryHint(result.rejectionReason),
    };
    return rejectedResult(details);
  }

  const stdoutStripped = stripSubstrateTruncationMarker(result.stdout);
  const stderrStripped = stripSubstrateTruncationMarker(result.stderr);
  const stdout = middleTruncateUtf8(stdoutStripped.text, maxOutputBytes);
  const stderr = middleTruncateUtf8(stderrStripped.text, maxOutputBytes);
  const details: RunCommandSuccessDetails = {
    ok: true,
    tool: input.tool,
    kind: input.kind,
    status: result.timedOut ? 'timed_out' : 'completed',
    commandClass: result.commandClass,
    approval: result.approval,
    command: normalizedCommand,
    cwd: effectiveCwd,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutMeta: {
      originalByteLength: stdout.originalByteLength,
      truncated: stdoutStripped.substrateTruncated || stdout.truncated,
    },
    stderrMeta: {
      originalByteLength: stderr.originalByteLength,
      truncated: stderrStripped.substrateTruncated || stderr.truncated,
    },
    truncated: result.truncated || stdout.truncated || stderr.truncated,
  };

  return {
    content: [{ type: 'text', text: summarizeResult(details) }],
    details,
  };
}

function rejectedResult(details: RunCommandRejectedDetails): WavemillToolResult<RunCommandDetails> {
  return {
    content: [{ type: 'text', text: details.message }],
    details,
  };
}

function summarizeResult(details: RunCommandSuccessDetails): string {
  if (details.status === 'timed_out') {
    return `${details.tool} timed out after ${details.durationMs}ms in ${details.cwd}.`;
  }
  const exitCodeText = details.exitCode === null ? 'null' : String(details.exitCode);
  return `${details.tool} completed in ${details.durationMs}ms with exit code ${exitCodeText} in ${details.cwd}.`;
}

function mapRejectionToError(
  rejectionReason: RejectionReason | string | undefined,
): RunCommandRejectedDetails['error'] {
  if (rejectionReason === 'cwd-outside-allowed-roots') {
    return 'cwd_outside_allowed_roots';
  }
  if (rejectionReason === 'dangerous-command-pattern') {
    return 'unsafe_command';
  }
  if (rejectionReason === 'empty-command') {
    return 'invalid_input';
  }
  return 'invalid_input';
}

function rejectionMessage(rejectionReason: RejectionReason | string | undefined): string {
  if (rejectionReason === 'cwd-outside-allowed-roots') {
    return 'Command cwd must stay inside the active worktree.';
  }
  if (rejectionReason === 'dangerous-command-pattern') {
    return 'Command was rejected by the native safety classifier.';
  }
  if (rejectionReason === 'empty-command') {
    return 'command must be a non-empty string.';
  }
  return 'Command could not be executed due to invalid input.';
}

function rejectionRetryHint(rejectionReason: RejectionReason | string | undefined): string | undefined {
  if (rejectionReason === 'cwd-outside-allowed-roots') {
    return 'Retry with the worktree root or a subdirectory inside it.';
  }
  if (rejectionReason === 'dangerous-command-pattern') {
    return 'Retry with a safer scoped test or formatter command.';
  }
  if (rejectionReason === 'empty-command') {
    return 'Provide a concrete command and retry.';
  }
  return undefined;
}

function internalCap(callerMaxBytes: number): number {
  return Math.max(callerMaxBytes * INTERNAL_CAP_MULTIPLIER, INTERNAL_CAP_FLOOR_BYTES);
}

function stripSubstrateTruncationMarker(text: string): { text: string; substrateTruncated: boolean } {
  if (text.endsWith(`\n${SUBSTRATE_TRUNCATION_MARKER}`)) {
    return {
      text: text.slice(0, -(`\n${SUBSTRATE_TRUNCATION_MARKER}`.length)),
      substrateTruncated: true,
    };
  }
  if (text.endsWith(SUBSTRATE_TRUNCATION_MARKER)) {
    return {
      text: text.slice(0, -SUBSTRATE_TRUNCATION_MARKER.length).trimEnd(),
      substrateTruncated: true,
    };
  }
  return { text, substrateTruncated: false };
}

function middleTruncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalByteLength: number } {
  const originalByteLength = Buffer.byteLength(text, 'utf8');
  if (originalByteLength <= maxBytes) {
    return { text, truncated: false, originalByteLength };
  }
  if (maxBytes <= 0) {
    return { text: '', truncated: true, originalByteLength };
  }

  const fallback = truncateUtf8(text, maxBytes);
  const minimumMarker = makeMiddleTruncationMarker(0);
  if (Buffer.byteLength(minimumMarker, 'utf8') >= maxBytes) {
    return { text: fallback, truncated: true, originalByteLength };
  }

  let headBudget = Math.floor((maxBytes - Buffer.byteLength(minimumMarker, 'utf8')) / 2);
  let tailBudget = maxBytes - Buffer.byteLength(minimumMarker, 'utf8') - headBudget;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const head = truncateUtf8(text, headBudget);
    const tail = sliceUtf8Tail(text, tailBudget);
    const retainedBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
    const marker = makeMiddleTruncationMarker(Math.max(originalByteLength - retainedBytes, 0));
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    if (retainedBytes + markerBytes <= maxBytes) {
      return { text: `${head}${marker}${tail}`, truncated: true, originalByteLength };
    }

    const remaining = Math.max(maxBytes - markerBytes, 0);
    headBudget = Math.floor(remaining / 2);
    tailBudget = remaining - headBudget;
  }

  return { text: fallback, truncated: true, originalByteLength };
}

function sliceUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= maxBytes) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return text.slice(low);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
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

function makeMiddleTruncationMarker(droppedBytes: number): string {
  return `\n...[truncated ${droppedBytes} bytes from the middle]...\n`;
}

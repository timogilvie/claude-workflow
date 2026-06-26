import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { CommandClass } from './command-classifier.ts';
import { classifyCommand } from './command-classifier.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const DEFAULT_ENV_KEYS = ['PATH', 'HOME', 'LANG'] as const;
const TRUNCATION_MARKER = '[output truncated]';
const REDACTION_TEXT = '«redacted»';

export type ApprovalOutcome = 'approved' | 'rejected';

export type RejectionReason =
  | 'empty-command'
  | 'dangerous-command-pattern'
  | 'cwd-outside-allowed-roots';

export interface RunCommandOptions {
  command: string | readonly string[];
  cwd: string;
  allowedRoots: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedEnvKeys?: readonly string[];
  redactValues?: readonly string[];
  shell?: boolean;
  spawnFn?: typeof spawn;
  signal?: AbortSignal;
}

export interface CommandResult {
  commandClass: CommandClass;
  approval: ApprovalOutcome;
  rejectionReason?: RejectionReason | string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export function resolveAllowedCwd(
  cwd: string,
  allowedRoots: readonly string[],
): { kind: 'inside'; resolved: string } | { kind: 'outside' } {
  try {
    const resolvedCwd = realpathSync(cwd);
    for (const root of allowedRoots) {
      const resolvedRoot = realpathSync(root);
      if (resolvedCwd === resolvedRoot) {
        return { kind: 'inside', resolved: resolvedCwd };
      }
      const relative = path.relative(resolvedRoot, resolvedCwd);
      if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return { kind: 'inside', resolved: resolvedCwd };
      }
    }
  } catch {
    return { kind: 'outside' };
  }

  return { kind: 'outside' };
}

export function buildChildEnv(
  allowedEnvKeys: readonly string[] | undefined,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowlist = new Set<string>(DEFAULT_ENV_KEYS);
  for (const key of allowedEnvKeys ?? []) {
    if (key.trim().length > 0) {
      allowlist.add(key);
    }
  }
  for (const key of allowlist) {
    const value = parentEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Run a command through the shared native-agent command substrate.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const timeoutMs = validatePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = validatePositiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
  );

  if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) {
    throw new Error('cwd is required.');
  }
  if (!Array.isArray(options.allowedRoots) || options.allowedRoots.length === 0) {
    throw new Error('allowedRoots must contain at least one root.');
  }

  const startedAt = Date.now();
  const classification = classifyCommand(options.command);
  if (classification.commandClass === 'dangerous') {
    return rejectionResult(classification.commandClass, classification.rejectionReason ?? 'dangerous-command-pattern', startedAt);
  }

  const cwdResolution = resolveAllowedCwd(options.cwd, options.allowedRoots);
  if (cwdResolution.kind === 'outside') {
    return rejectionResult(classification.commandClass, 'cwd-outside-allowed-roots', startedAt);
  }

  const env = buildChildEnv(options.allowedEnvKeys, process.env);
  const spawnFn = options.spawnFn ?? spawn;
  const spawnSpec = buildSpawnSpec(options.command, options.shell === true);
  const spawnOptions: SpawnOptions = {
    cwd: cwdResolution.resolved,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  const child = spawnFn(spawnSpec.file, spawnSpec.args, spawnOptions);
  return await waitForProcess({
    child,
    commandClass: classification.commandClass,
    maxOutputBytes,
    timeoutMs,
    redactValues: options.redactValues,
    signal: options.signal,
    startedAt,
  });
}

function validatePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function rejectionResult(commandClass: CommandClass, rejectionReason: RejectionReason, startedAt: number): CommandResult {
  return {
    commandClass,
    approval: 'rejected',
    rejectionReason,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    durationMs: Date.now() - startedAt,
  };
}

function buildSpawnSpec(command: string | readonly string[], shell: boolean): { file: string; args: string[] } {
  if (typeof command === 'string') {
    if (shell) {
      return {
        file: '/bin/sh',
        args: ['-c', command],
      };
    }
    const parts = command
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      throw new Error('command must not be empty.');
    }
    return {
      file: parts[0]!,
      args: parts.slice(1),
    };
  }

  if (command.length === 0) {
    throw new Error('command must not be empty.');
  }
  return {
    file: command[0]!,
    args: command.slice(1) as string[],
  };
}

function waitForProcess(input: {
  child: ChildProcess;
  commandClass: CommandClass;
  maxOutputBytes: number;
  timeoutMs: number;
  redactValues?: readonly string[];
  signal?: AbortSignal;
  startedAt: number;
}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      input.child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        input.child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, input.timeoutMs);

    const abortHandler = () => {
      timedOut = true;
      input.child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        input.child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    if (input.signal) {
      if (input.signal.aborted) {
        abortHandler();
      } else {
        input.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    input.child.stdout?.on('data', (chunk: Buffer | string) => {
      const next = chunkToString(chunk);
      const captured = captureOutput(stdout, next, input.maxOutputBytes);
      stdout = captured.text;
      stdoutTruncated = stdoutTruncated || captured.truncated;
    });

    input.child.stderr?.on('data', (chunk: Buffer | string) => {
      const next = chunkToString(chunk);
      const captured = captureOutput(stderr, next, input.maxOutputBytes);
      stderr = captured.text;
      stderrTruncated = stderrTruncated || captured.truncated;
    });

    input.child.on('error', (error) => {
      stderr = captureOutput(stderr, error.message, input.maxOutputBytes).text;
    });

    input.child.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      finalize();
    });

    function finalize(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (input.signal) {
        input.signal.removeEventListener('abort', abortHandler);
      }

      const truncated = stdoutTruncated || stderrTruncated;
      const result: CommandResult = {
        commandClass: input.commandClass,
        approval: 'approved',
        exitCode,
        signal: exitSignal,
        stdout: redactOutput(appendTruncationMarker(stdout, stdoutTruncated), input.redactValues),
        stderr: redactOutput(appendTruncationMarker(stderr, stderrTruncated), input.redactValues),
        truncated,
        timedOut,
        durationMs: Date.now() - input.startedAt,
      };

      resolve(result);
    }
  });
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

function captureOutput(current: string, chunk: string, maxOutputBytes: number): { text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, 'utf8');
  if (currentBytes >= maxOutputBytes) {
    return { text: current, truncated: true };
  }

  const remainingBytes = maxOutputBytes - currentBytes;
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  if (chunkBytes <= remainingBytes) {
    return { text: current + chunk, truncated: false };
  }

  const retained = chunk.slice(0, remainingBytes);
  return {
    text: current + retained,
    truncated: true,
  };
}

function appendTruncationMarker(text: string, truncated: boolean): string {
  if (!truncated) {
    return text;
  }
  if (text.endsWith(TRUNCATION_MARKER)) {
    return text;
  }
  return `${text}${text.length > 0 ? '\n' : ''}${TRUNCATION_MARKER}`;
}

function redactOutput(text: string, redactValues?: readonly string[]): string {
  let next = text;
  for (const value of redactValues ?? []) {
    if (value.trim().length === 0) {
      continue;
    }
    next = next.split(value).join(REDACTION_TEXT);
  }
  return next;
}

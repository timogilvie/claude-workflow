import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execShellCommand, escapeShellArg } from './shell-utils.ts';
import type { PrePrVerificationConfig, PrePrVerificationCommandConfig } from './config.ts';

export const PRE_PR_ARTIFACT_NAME = '.pre-pr-verification.json';
export const PRE_PR_SCHEMA_VERSION = '1.0';
const LOG_HEAD_BYTES = 64 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const EXCERPT_BYTES = 8 * 1024;

export interface VerificationCommandResult {
  name: string;
  run: string;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  logPath?: string;
  logExcerpt?: string;
  mapsToCheck?: string;
  attempt?: number;
}

export interface VerificationArtifact {
  schemaVersion: '1.0';
  repo: string;
  branch: string;
  headSha: string;
  baseSha: string;
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed' | 'timeout' | 'error';
  commands: VerificationCommandResult[];
  override?: {
    operator: string;
    reason: string;
    timestamp: string;
  };
  configSource: 'explicit' | 'github-enforced';
}

export type FreshnessReason = 'missing' | 'stale-head' | 'stale-base' | 'failed' | 'schema-mismatch' | 'passed';

export interface FreshnessResult {
  reason: FreshnessReason;
  artifact?: VerificationArtifact;
  message: string;
}

export interface RunPrePrVerificationOptions {
  worktreeDir: string;
  featureDir: string;
  baseRef: string;
  config: PrePrVerificationConfig;
  override?: {
    operator: string;
    reason: string;
  };
}

function git(repoDir: string, args: string): string {
  return execShellCommand(`git ${args}`, { cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

export function prePrArtifactPath(featureDir: string): string {
  return path.join(featureDir, PRE_PR_ARTIFACT_NAME);
}

function resolveBaseSha(worktreeDir: string, baseRef: string): string {
  const candidates = [baseRef, `origin/${baseRef}`];
  let lastError = '';
  for (const candidate of candidates) {
    try {
      return git(worktreeDir, `rev-parse ${escapeShellArg(candidate)}`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Unable to resolve base ref ${baseRef}: ${lastError}`);
}

function relativeLogPath(featureDir: string, logPath: string): string {
  return path.relative(featureDir, logPath).split(path.sep).join('/');
}

async function boundedLogFile(logPath: string): Promise<string> {
  const data = await fs.readFile(logPath);
  if (data.byteLength <= LOG_HEAD_BYTES + LOG_TAIL_BYTES) {
    return data.toString('utf8');
  }
  const head = data.subarray(0, LOG_HEAD_BYTES).toString('utf8');
  const tail = data.subarray(data.byteLength - LOG_TAIL_BYTES).toString('utf8');
  const marker = `\n\n[pre-pr-verification log truncated: kept first ${LOG_HEAD_BYTES} and last ${LOG_TAIL_BYTES} bytes]\n\n`;
  const bounded = `${head}${marker}${tail}`;
  await fs.writeFile(logPath, bounded, 'utf8');
  return bounded;
}

function excerpt(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= EXCERPT_BYTES) {
    return text;
  }
  return bytes.subarray(bytes.byteLength - EXCERPT_BYTES).toString('utf8');
}

async function runCommand(input: {
  command: PrePrVerificationCommandConfig;
  worktreeDir: string;
  logPath: string;
  timeoutSeconds: number;
  attempt: number;
}): Promise<VerificationCommandResult> {
  await fs.mkdir(path.dirname(input.logPath), { recursive: true });
  const log = createWriteStream(input.logPath, { flags: 'w' });
  const started = Date.now();

  return await new Promise<VerificationCommandResult>((resolve) => {
    const child = spawn(input.command.run, {
      cwd: input.worktreeDir,
      shell: '/bin/bash',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, input.timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => log.write(chunk));
    child.stderr.on('data', (chunk) => log.write(chunk));
    child.on('error', (error) => log.write(`\n[spawn error] ${error instanceof Error ? error.message : String(error)}\n`));
    child.on('close', async (code) => {
      clearTimeout(timer);
      log.end();
      await new Promise<void>((done) => log.on('finish', done));
      const content = await boundedLogFile(input.logPath);
      resolve({
        name: input.command.name,
        run: input.command.run,
        mapsToCheck: input.command.mapsToCheck,
        exitCode: timedOut ? undefined : code ?? 1,
        durationMs: Date.now() - started,
        timedOut,
        logPath: relativeLogPath(path.dirname(path.dirname(input.logPath)), input.logPath),
        logExcerpt: excerpt(content),
        attempt: input.attempt,
      });
    });
  });
}

async function writeArtifactAtomic(artifactPath: string, artifact: VerificationArtifact): Promise<void> {
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  const tmp = `${artifactPath}.tmp.${process.pid}.${Date.now()}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, artifactPath);
}

export async function runPrePrVerification(options: RunPrePrVerificationOptions): Promise<VerificationArtifact> {
  if (!options.config.commands || options.config.commands.length === 0) {
    throw new Error('prePrVerification.commands must contain at least one command for required/advisory mode');
  }

  const startedAt = new Date().toISOString();
  const repo = git(options.worktreeDir, 'remote get-url origin').replace(/\.git$/, '');
  const branch = git(options.worktreeDir, 'rev-parse --abbrev-ref HEAD');
  const headSha = git(options.worktreeDir, 'rev-parse HEAD');
  const baseSha = resolveBaseSha(options.worktreeDir, options.baseRef);
  const commands: VerificationCommandResult[] = [];
  const logDir = path.join(options.featureDir, 'pre-pr-logs');

  if (options.override) {
    const artifact: VerificationArtifact = {
      schemaVersion: PRE_PR_SCHEMA_VERSION,
      repo,
      branch,
      headSha,
      baseSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'passed',
      commands,
      override: {
        ...options.override,
        timestamp: new Date().toISOString(),
      },
      configSource: options.config.source ?? 'explicit',
    };
    await writeArtifactAtomic(prePrArtifactPath(options.featureDir), artifact);
    return artifact;
  }

  const retry = options.config.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? 1;
  const retryOn = retry.retryOn ?? 'timeout';
  let status: VerificationArtifact['status'] = 'passed';

  for (let i = 0; i < options.config.commands.length; i += 1) {
    const command = options.config.commands[i];
    const timeoutSeconds = command.timeoutSeconds ?? options.config.overallTimeoutSeconds ?? 3600;
    let result: VerificationCommandResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result = await runCommand({
        command,
        worktreeDir: options.worktreeDir,
        logPath: path.join(logDir, `${String(i + 1).padStart(2, '0')}-${command.name}.log`),
        timeoutSeconds,
        attempt,
      });
      commands.push(result);
      const failed = result.timedOut || (result.exitCode ?? 1) !== 0;
      const shouldRetry = failed && attempt < maxAttempts && (retryOn === 'any' || result.timedOut);
      if (!shouldRetry) break;
    }
    if (result?.timedOut) {
      status = 'timeout';
      break;
    }
    if ((result?.exitCode ?? 1) !== 0) {
      status = 'failed';
      break;
    }
  }

  const artifact: VerificationArtifact = {
    schemaVersion: PRE_PR_SCHEMA_VERSION,
    repo,
    branch,
    headSha,
    baseSha,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    commands,
    configSource: options.config.source ?? 'explicit',
  };
  await writeArtifactAtomic(prePrArtifactPath(options.featureDir), artifact);
  return artifact;
}

export async function validateArtifactFreshness(input: {
  artifactPath: string;
  worktreeDir: string;
  baseRef: string;
}): Promise<FreshnessResult> {
  if (!existsSync(input.artifactPath)) {
    return { reason: 'missing', message: 'pre-PR verification artifact is missing' };
  }
  let artifact: VerificationArtifact;
  try {
    artifact = JSON.parse(await fs.readFile(input.artifactPath, 'utf8')) as VerificationArtifact;
  } catch {
    return { reason: 'schema-mismatch', message: 'pre-PR verification artifact is malformed' };
  }
  if (artifact.schemaVersion !== PRE_PR_SCHEMA_VERSION) {
    return { reason: 'schema-mismatch', artifact, message: 'pre-PR verification artifact schema version is not recognized' };
  }
  const headSha = git(input.worktreeDir, 'rev-parse HEAD');
  const baseSha = resolveBaseSha(input.worktreeDir, input.baseRef);
  if (artifact.headSha !== headSha) {
    return { reason: 'stale-head', artifact, message: 'pre-PR verification artifact does not match HEAD' };
  }
  if (artifact.baseSha !== baseSha) {
    return { reason: 'stale-base', artifact, message: 'pre-PR verification artifact does not match base' };
  }
  if (artifact.status !== 'passed' && !artifact.override) {
    return { reason: 'failed', artifact, message: `pre-PR verification status is ${artifact.status}` };
  }
  return { reason: 'passed', artifact, message: 'pre-PR verification artifact is fresh and passing' };
}

export function findFeatureDirForBranch(repoDir: string, branch: string): string | null {
  const slug = branch.startsWith('task/') ? branch.slice('task/'.length) : branch.replace(/[^A-Za-z0-9._-]+/g, '-');
  const candidate = path.join(repoDir, 'features', slug);
  return existsSync(candidate) ? candidate : null;
}

export function tempRepoRoot(): string {
  return path.join(os.tmpdir(), 'wavemill-pre-pr');
}

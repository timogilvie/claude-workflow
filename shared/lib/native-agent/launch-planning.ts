import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import type { AgentMessage, AgentTurn, Message } from './messages.ts';
import type { AgentContext, WavemillLoopConfig } from './loop.ts';
import { runWavemillLoop } from './loop.ts';
import {
  buildNativeProviderResolutionFailureMessage,
  getNativeProviderApiKey,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';
import { TranscriptWriter } from './transcript.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { createGitTools, gitAfterToolCall } from './tools/git.ts';
import { createArtifactTools } from './tools/artifacts.ts';
import { createToolRegistry } from './tools/registry.ts';
import { toPiAgentTool, type AgentTool } from './tools/pi-adapter.ts';
import type { ToolDescriptor, ToolMetadata, WavemillToolResult } from './tools/types.ts';
import { loadNativePhasePrompt, registerAndRecordNativeProvenance } from './prompts.ts';
import { isTaskPacketContent } from '../task-packet-utils.ts';
import { createCleanupTracker, runCleanup, type CleanupReason } from './cleanup.ts';
import { updateStageResult } from '../stage-result.ts';

const RELEASE_READINESS_STUB = [
  '',
  '## Release Readiness',
  '',
  '- **database_change_risk**: unknown',
  '- **env_changes**: none',
  '- **config_changes**: none',
  '- **manual_steps**: none',
  '',
].join('\n');

const DEFAULT_HELPER_TIMEOUT_MS = 12 * 60 * 1000;

type HookState = 'working' | 'idle' | 'error';

export interface LaunchNativePlanningOptions {
  session: string;
  issue: string;
  slug: string;
  wtDir: string;
  repoDir: string;
  phase?: 'planning' | 'coding' | 'review';
  planDepth?: string;
  operatingMode?: string;
  branch?: string;
  baseBranch?: string;
  title?: string;
  issueContext?: string;
  linearIssue?: string;
  taskPacketPath?: string;
  routeOutputPath?: string;
  planPath?: string;
  approvalMarkerPath?: string;
  migrationMarkerPath?: string;
  hookPath?: string;
  providerEntries?: readonly ReadyNativeProviderEntry[];
  loopModelOverride?: WavemillLoopConfig['model'];
  registryMetadataOverride?: readonly ToolMetadata[];
  extraDescriptors?: readonly ToolDescriptor[];
  runTsxCommand?: (args: string[]) => string;
  signal?: AbortSignal;
}

function writeHookStatus(
  hookPath: string,
  state: HookState,
  event: string,
  detail: string,
  agent: string,
): void {
  const tmpPath = `${hookPath}.tmp.${process.pid}.${Date.now()}`;
  let base: Record<string, unknown> = {};
  if (existsSync(hookPath)) {
    try {
      base = JSON.parse(readFileSync(hookPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const payload = {
    ...base,
    state,
    event,
    agent,
    timestamp: Math.floor(Date.now() / 1000),
    ...(detail !== '' ? { detail } : {}),
  };
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, 'utf-8');
  renameSync(tmpPath, hookPath);
}

function helperTimeoutMs(): number {
  const raw = process.env.WAVEMILL_NATIVE_PLANNING_HELPER_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_HELPER_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HELPER_TIMEOUT_MS;
}

function execTsx(repoDir: string, args: string[]): string {
  try {
    return execFileSync('npx', ['tsx', ...args], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: helperTimeoutMs(),
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    const err = error as Error & { signal?: NodeJS.Signals; killed?: boolean };
    if (err.signal === 'SIGTERM' || err.killed) {
      throw new Error(`Native planning helper timed out: npx tsx ${args.join(' ')}`);
    }
    throw error;
  }
}

function ensureTaskPacket(
  repoDir: string,
  issue: string,
  linearIssue: string | undefined,
  taskPacketPath: string,
  runTsxCommand: (args: string[]) => string,
): void {
  const existing = existsSync(taskPacketPath) ? readFileSync(taskPacketPath, 'utf-8') : '';
  if (existing.trim() !== '' && isTaskPacketContent(existing)) {
    return;
  }

  const expandIssue = normalizeLinearIssueIdentifier(linearIssue) ?? normalizeLinearIssueIdentifier(issue);
  if (!expandIssue) {
    throw new Error(`Cannot expand task packet for invalid Linear issue identifier: ${issue}`);
  }

  runTsxCommand([
    'tools/expand-issue.ts',
    expandIssue,
    '--output',
    taskPacketPath,
    '--repo-path',
    repoDir,
  ]);
}

function normalizeLinearIssueIdentifier(issue: string | undefined): string | null {
  const trimmed = issue?.trim();
  if (!trimmed) {
    return null;
  }
  const direct = trimmed.match(/^[A-Z][A-Z0-9]*-[0-9]+$/);
  if (direct) {
    return trimmed;
  }
  const challenger = trimmed.match(/^([A-Z][A-Z0-9]*-[0-9]+)_c$/);
  if (challenger?.[1]) {
    return challenger[1];
  }
  const url = trimmed.match(/^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-[0-9]+)(?:[/?#].*)?$/);
  return url?.[1] ?? null;
}

function routeTaskPacket(
  taskPacketPath: string,
  routeOutputPath: string,
  repoDir: string,
  runTsxCommand: (args: string[]) => string,
): void {
  runTsxCommand([
    'tools/route-task.ts',
    '--json',
    '--file',
    taskPacketPath,
    '--output',
    routeOutputPath,
    '--repo-dir',
    repoDir,
    '--source',
    'expanded',
    '--input-kind',
    'task-packet',
  ]);
}

function maybeWriteMigrationMarker(taskPacketPath: string, migrationMarkerPath: string): void {
  const packet = readFileSync(taskPacketPath, 'utf-8');
  if (/\b(alembic|migration|schema)\b/i.test(packet)) {
    writeFileSync(migrationMarkerPath, '', 'utf-8');
  } else if (existsSync(migrationMarkerPath)) {
    rmSync(migrationMarkerPath, { force: true });
  }
}

function buildUserPrompt(options: {
  slug: string;
  title?: string;
  issue: string;
  planDepth: string;
  operatingMode: string;
  branch?: string;
  baseBranch?: string;
  issueContext?: string;
  taskPacket: string;
}): string {
  return [
    `Issue: ${options.issue}`,
    `Slug: ${options.slug}`,
    `Title: ${options.title || options.issue}`,
    `Plan depth: ${options.planDepth}`,
    `Operating mode: ${options.operatingMode}`,
    `Branch: ${options.branch || ''}`,
    `Base branch: ${options.baseBranch || ''}`,
    '',
    'Produce the planning artifact as final markdown only.',
    'The final response will be written directly to features/<slug>/plan.md.',
    'Include a "## Release Readiness" section.',
    'Use read-only tools only.',
    '',
    options.issueContext ? `Issue Context:\n${options.issueContext.trim()}\n` : '',
    'Task Packet:',
    options.taskPacket.trim(),
  ].filter(Boolean).join('\n');
}

function findFinalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as { role?: string }).role !== 'assistant') {
      continue;
    }
    const content = ((message as AgentTurn).content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();
    if (content !== '') {
      return content;
    }
  }
  return '';
}

function findFinalAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as { role?: string }).role !== 'assistant') {
      continue;
    }
    const errorMessage = (message as AgentTurn).errorMessage?.trim();
    if (errorMessage) {
      return errorMessage;
    }
  }
  return '';
}

function ensureReleaseReadiness(planText: string): string {
  if (/^##\s+Release Readiness\b/m.test(planText)) {
    return planText;
  }
  console.warn('[native-planning] Plan output missing Release Readiness section; appending stub');
  return `${planText.trimEnd()}\n${RELEASE_READINESS_STUB}`;
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  renameSync(tmpPath, path);
}

function defaultHookPath(session: string, issue: string): string {
  return `/tmp/wavemill-${session}-${issue}.hook`;
}

function toPiTools(descriptors: readonly ToolDescriptor[]): AgentTool<unknown, unknown>[] {
  return descriptors.map((descriptor) => toPiAgentTool(descriptor) as AgentTool<unknown, unknown>);
}

function cleanupReasonForStopReason(stopReason: string): CleanupReason | null {
  if (stopReason === 'aborted') {
    return 'aborted';
  }
  if (stopReason === 'wall_clock_limit') {
    return 'timeout';
  }
  return null;
}

function makeTranscriptPath(repoDir: string, session: string, issue: string): string {
  const safeIssue = issue.replace(/[^A-Za-z0-9._-]+/g, '-');
  const baseDir = process.env.WAVEMILL_RUN_DIR
    ? join(process.env.WAVEMILL_RUN_DIR, 'native-sessions')
    : join(repoDir, '.wavemill', 'runs', session, 'native-sessions');
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `planning-${safeIssue}.jsonl`);
}

export async function launchNativePlanning(options: LaunchNativePlanningOptions): Promise<{
  planPath: string;
  approvalMarkerPath: string;
  hookPath: string;
  provider: string;
  model: string;
  stopReason: string;
  transcriptPath: string;
}> {
  const phase = options.phase ?? 'planning';
  assert.equal(phase, 'planning', 'launchNativePlanning only supports the planning phase');

  const featureDir = join(options.wtDir, 'features', options.slug);
  const taskPacketPath = options.taskPacketPath ?? join(featureDir, 'task-packet.md');
  const routeOutputPath = options.routeOutputPath ?? join(featureDir, '.post-expansion-route.json');
  const planPath = options.planPath ?? join(featureDir, 'plan.md');
  const approvalMarkerPath = options.approvalMarkerPath ?? join(featureDir, '.plan-approved');
  const migrationMarkerPath = options.migrationMarkerPath ?? join(featureDir, '.migration-detected');
  const hookPath = options.hookPath ?? defaultHookPath(options.session, options.issue);
  const planDepth = options.planDepth ?? 'light';
  const operatingMode = options.operatingMode ?? 'normal';
  const runTsxCommand = options.runTsxCommand ?? ((args: string[]) => execTsx(options.repoDir, args));

  writeHookStatus(hookPath, 'working', 'launch_native_planning', options.loopModelOverride?.name ?? 'native', 'native');

  try {
    mkdirSync(featureDir, { recursive: true });
    ensureTaskPacket(options.repoDir, options.issue, options.linearIssue, taskPacketPath, runTsxCommand);
    routeTaskPacket(taskPacketPath, routeOutputPath, options.repoDir, runTsxCommand);
    maybeWriteMigrationMarker(taskPacketPath, migrationMarkerPath);

    const descriptors = [
      ...createReadOnlyTools(options.wtDir),
      ...createGitTools(options.wtDir),
      ...createArtifactTools(options.wtDir),
      ...(options.extraDescriptors ?? []),
    ];
    const registry = createToolRegistry(descriptors);
    const registryMetadata = options.registryMetadataOverride ?? registry.list();

    const providerEntries = options.providerEntries
      ?? resolveNativeAgentProviders(options.repoDir, { phase: 'planning' });
    const readyProvider = providerEntries.find(
      (entry): entry is ReadyNativeProviderEntry => entry.status === 'ready',
    );

    if (!readyProvider && !options.loopModelOverride) {
      throw new Error(buildNativeProviderResolutionFailureMessage('planning', providerEntries));
    }

    const taskPacket = readFileSync(taskPacketPath, 'utf-8');
    const { content: systemPrompt, promptRef } = loadNativePhasePrompt(options.repoDir);
    const apiKey = readyProvider ? getNativeProviderApiKey(readyProvider) : undefined;
    const model = options.loopModelOverride ?? {
      ...readyProvider!.model,
      headers: {
        ...(readyProvider!.model.headers ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    };
    const transcriptPath = makeTranscriptPath(options.repoDir, options.session, options.issue);
    const transcriptWriter = new TranscriptWriter({
      sessionId: `${options.session}-planning-${options.issue}`,
      model: model.name ?? model.id,
      api: model.api,
      provider: model.provider,
      worktreePath: options.wtDir,
      gitBranch: options.branch,
      path: transcriptPath,
    });

    registerAndRecordNativeProvenance({
      sessionId: options.session,
      phase: 'planning',
      provider: model.provider,
      model: model.name ?? model.id,
      api: model.api,
      tools: registryMetadata.map((meta) => ({ name: meta.name, class: meta.class })),
      promptRef,
      repoDir: options.repoDir,
    });

    const cleanupTracker = createCleanupTracker();
    const context: AgentContext = {
      systemPrompt,
      messages: [{
        role: 'user',
        content: buildUserPrompt({
          slug: options.slug,
          title: options.title,
          issue: options.issue,
          planDepth,
          operatingMode,
          branch: options.branch,
          baseBranch: options.baseBranch,
          issueContext: options.issueContext,
          taskPacket,
        }),
        timestamp: 0,
      }],
      tools: toPiTools(descriptors),
    };

    const result = await runWavemillLoop({
      model,
      context,
      convertToLlm: (messages) => messages as unknown as Message[],
      afterToolCall: gitAfterToolCall,
      signal: options.signal,
      toolPolicy: {
        phase: 'planning',
        worktreePath: options.wtDir,
        registry: registryMetadata,
        config: {
          pathFieldsByTool: READ_ONLY_PATH_FIELDS,
        },
      },
      onEvent: (event) => {
        transcriptWriter.handleEvent(event);
      },
    });

    const cleanupReason = cleanupReasonForStopReason(result.stopReason);
    if (cleanupReason) {
      const cleanupReport = await runCleanup(cleanupTracker, {
        worktreePath: options.wtDir,
        reason: cleanupReason,
      });
      await updateStageResult(featureDir, 'planning', {
        status: cleanupReason === 'aborted' ? 'aborted' : 'failed',
        finishedAt: new Date().toISOString(),
        agent: 'native',
        model: model.name ?? model.id,
        notes: `Native planning stopped with ${result.stopReason}; cleanup decision ${cleanupReport.cleanupDecision}.`,
        failureReason: result.stopReason,
        finalTreeState: cleanupReport.finalTreeState,
        cleanupDecision: cleanupReport.cleanupDecision,
        cleanupReport,
      });
    }

    const rawFinalText = findFinalAssistantText(result.messages);
    if (rawFinalText.trim() === '') {
      const providerError = findFinalAssistantErrorMessage(result.messages);
      if (providerError) {
        throw new Error(`Native planning failed: ${providerError}`);
      }
      throw new Error(`Native planning completed without a final plan (stopReason=${result.stopReason})`);
    }
    const finalText = ensureReleaseReadiness(rawFinalText);

    atomicWriteText(planPath, finalText);
    writeFileSync(approvalMarkerPath, '', 'utf-8');
    writeHookStatus(hookPath, 'idle', 'process_exit', 'planning_completed', 'native');

    return {
      planPath,
      approvalMarkerPath,
      hookPath,
      provider: model.provider,
      model: model.name ?? model.id,
      stopReason: result.stopReason,
      transcriptPath,
    };
  } catch (err) {
    writeHookStatus(hookPath, 'error', 'process_exit', (err as Error).message, 'native');
    throw err;
  }
}

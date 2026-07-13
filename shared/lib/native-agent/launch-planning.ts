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
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';
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

function execTsx(repoDir: string, args: string[]): string {
  return execFileSync('npx', ['tsx', ...args], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ensureTaskPacket(
  repoDir: string,
  issue: string,
  taskPacketPath: string,
  runTsxCommand: (args: string[]) => string,
): void {
  const existing = existsSync(taskPacketPath) ? readFileSync(taskPacketPath, 'utf-8') : '';
  if (existing.trim() !== '' && isTaskPacketContent(existing)) {
    return;
  }

  runTsxCommand([
    'tools/expand-issue.ts',
    issue,
    '--output',
    taskPacketPath,
    '--repo-path',
    repoDir,
  ]);
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

export async function launchNativePlanning(options: LaunchNativePlanningOptions): Promise<{
  planPath: string;
  approvalMarkerPath: string;
  hookPath: string;
  provider: string;
  model: string;
  stopReason: string;
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
    ensureTaskPacket(options.repoDir, options.issue, taskPacketPath, runTsxCommand);
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
    const model = options.loopModelOverride ?? readyProvider!.model;

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
    };
  } catch (err) {
    writeHookStatus(hookPath, 'error', 'process_exit', (err as Error).message, 'native');
    throw err;
  }
}

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentContext, WavemillLoopConfig } from './loop.ts';
import { runWavemillLoop } from './loop.ts';
import type { AgentMessage, AgentTurn, Message } from './messages.ts';
import {
  buildNativeProviderResolutionFailureMessage,
  getNativeProviderApiKey,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
} from './providers.ts';
import { TranscriptWriter } from './transcript.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import {
  createGitCommitTools,
  createGitTools,
  gitAfterToolCall,
  gitMutationAfterToolCall,
  gitMutationToolPolicyConfig,
  gitToolPolicyConfig,
} from './tools/git.ts';
import {
  commandToolsAfterToolCall,
  createCommandTools,
} from './tools/command-tools.ts';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
} from './tools/mutation-tools.ts';
import {
  createIntendedFileTracker,
  intendedFilesAfterToolCall,
} from './tools/intended-files.ts';
import { createToolRegistry } from './tools/registry.ts';
import { toPiAgentTool, type AgentTool } from './tools/pi-adapter.ts';
import type { ToolDescriptor, ToolMetadata } from './tools/types.ts';
import { parseCodingComplete, validateCodingArtifacts, type CodingArtifacts } from './coding-artifacts.ts';
import {
  buildNoMarkerHandoff,
  getNoMarkerHandoffPath,
  writeNoMarkerHandoff,
  type CodingMutationFailure,
} from './coding-handoff.ts';
import {
  NATIVE_PATCH_EXAMPLE,
  validateNativePatch,
  type NativePatchValidationError,
} from './patch-contract.ts';
import { registerAndRecordNativeProvenance } from './prompts.ts';
import { updateStageResult } from '../stage-result.ts';
import { equivalentOpenRouterModelIds } from '../openrouter-catalog.ts';
import { logPromptUsage } from '../prompt-registry.ts';
import type { ResourceRef } from '../resource-registry.ts';
import {
  getBlockedCompletionPath,
  readBlockedCompletion,
} from '../blocked-completion.ts';

const CODING_PROMPT_PATH = new URL('../../../tools/prompts/coding-phase.md', import.meta.url);
const CODING_PROMPT_FILE = fileURLToPath(CODING_PROMPT_PATH);
const MUTATION_FAILURE_TOOLS = new Set(['apply_patch', 'write_artifact', 'create_marker', 'git_add', 'git_commit']);
const NO_MARKER_FAILURE_PREFIX = 'Native coding completed without .coding-complete or .coding-blocked-completion.json';
const TRACKED_TEXT_LIMIT = 4096;

type HookState = 'working' | 'idle' | 'error';

export interface LaunchNativeCodingOptions {
  session: string;
  issue: string;
  slug: string;
  wtDir: string;
  repoDir: string;
  codeDepth?: string;
  operatingMode?: string;
  branch?: string;
  baseBranch?: string;
  title?: string;
  issueContext?: string;
  resolvedModel?: string;
  featureDir?: string;
  taskPacketPath?: string;
  planPath?: string;
  hookPath?: string;
  providerEntries?: readonly ReadyNativeProviderEntry[];
  loopModelOverride?: WavemillLoopConfig['model'];
  registryMetadataOverride?: readonly ToolMetadata[];
  extraDescriptors?: readonly ToolDescriptor[];
  signal?: AbortSignal;
}

export interface LaunchNativeCodingResult {
  featureDir: string;
  hookPath: string;
  provider: string;
  model: string;
  stopReason: string;
  transcriptPath: string;
  completion: 'complete' | 'blocked';
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
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify({
    ...base,
    state,
    event,
    agent,
    timestamp: Math.floor(Date.now() / 1000),
    ...(detail !== '' ? { detail } : {}),
  })}\n`, 'utf-8');
  renameSync(tmpPath, hookPath);
}

function writeTextStatus(session: string, issue: string, text: string): void {
  if (!session || !issue) return;
  try {
    writeFileSync(`/tmp/${session}-${issue}-status.txt`, `${text}\n`, 'utf-8');
  } catch {
    // Best-effort dashboard text; hook JSON remains authoritative.
  }
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

function makeTranscriptPath(repoDir: string, session: string, issue: string): string {
  const safeIssue = issue.replace(/[^A-Za-z0-9._-]+/g, '-');
  const baseDir = process.env.WAVEMILL_RUN_DIR
    ? join(process.env.WAVEMILL_RUN_DIR, 'native-sessions')
    : join(repoDir, '.wavemill', 'runs', session, 'native-sessions');
  mkdirSync(baseDir, { recursive: true });
  return join(baseDir, `coding-${safeIssue}.jsonl`);
}

function toPiTools(descriptors: readonly ToolDescriptor[]): AgentTool<unknown, unknown>[] {
  return descriptors.map((descriptor) => toPiAgentTool(descriptor) as AgentTool<unknown, unknown>);
}

function canonicalNativeModelIds(modelId: string | undefined): Set<string> {
  const trimmed = modelId?.trim();
  return trimmed ? new Set(equivalentOpenRouterModelIds(trimmed)) : new Set();
}

function selectReadyProvider(
  providerEntries: readonly ReadyNativeProviderEntry[],
  resolvedModel: string | undefined,
): ReadyNativeProviderEntry | undefined {
  const requestedIds = canonicalNativeModelIds(resolvedModel);
  if (requestedIds.size === 0) {
    return providerEntries[0];
  }

  return providerEntries.find((entry) => {
    const entryIds = canonicalNativeModelIds(entry.modelId);
    if (entry.model.name) {
      for (const id of canonicalNativeModelIds(entry.model.name)) {
        entryIds.add(id);
      }
    }
    return [...requestedIds].some((id) => entryIds.has(id));
  });
}

function formatReadyProviderList(providerEntries: readonly ReadyNativeProviderEntry[]): string {
  return providerEntries.length === 0
    ? 'none'
    : providerEntries.map((entry) => `${entry.providerName}:${entry.modelId}`).join(', ');
}

function loadCodingPrompt(repoDir: string): { content: string; promptRef: ResourceRef | null } {
  let content = [
    'You are a native coding agent.',
    'Use the provided tools to implement, verify, commit, and write coding completion artifacts.',
  ].join('\n');
  const promptPath = CODING_PROMPT_FILE;
  try {
    if (existsSync(promptPath)) {
      content = readFileSync(promptPath, 'utf-8');
    }
  } catch {
    // Fallback prompt above is sufficient for controlled tests and failure recovery.
  }
  return { content, promptRef: logPromptUsage(promptPath, content, { dir: repoDir }) };
}

function buildDepthGuidance(codeDepth: string): string {
  if (codeDepth === 'deep') {
    return '- Implement comprehensive error handling\n- Add extensive test coverage\n- Consider edge cases and performance';
  }
  if (codeDepth === 'light') {
    return '- Focus on the critical path\n- Add targeted verification';
  }
  return '- Implement core functionality with good error handling\n- Add reasonable test coverage';
}

function buildModeGuidance(operatingMode: string): string {
  if (operatingMode === 'survival') {
    return 'Keep scope minimal, commit after every 1-2 file changes, and prefer targeted verification.';
  }
  if (operatingMode === 'constrained') {
    return 'Keep changes tightly scoped, commit after each plan phase, and run focused checks between phases.';
  }
  return '';
}

function renderCodingSystemPrompt(input: {
  template: string;
  codeDepth: string;
  operatingMode: string;
  featureDir: string;
  planPath: string;
  slug: string;
  blockedCompletionPath: string;
}): string {
  const rendered = input.template
    .replace(/\{\{CODE_DEPTH\}\}/g, input.codeDepth)
    .replace(/\{\{SLUG\}\}/g, input.slug)
    .replace(/\{\{FEATURE_DIR\}\}/g, input.featureDir)
    .replace(/\{\{PLAN_PATH\}\}/g, input.planPath)
    .replace(/\{\{DEPTH_GUIDANCE\}\}/g, buildDepthGuidance(input.codeDepth))
    .replace(/\{\{MODE_GUIDANCE\}\}/g, buildModeGuidance(input.operatingMode));

  return [
    rendered,
    '',
    '### Native Coding Tool Rules',
    '- Use apply_patch for source edits; do not use whole-file writes for source files.',
    `- apply_patch payloads must follow the NativePatch envelope: {"version": 1, "atomic": true, "operations": [{"op": "edit", "path": "...", "oldText": "...", "newText": "..."}]} (or {"op": "edit-diff", "path": "...", "diff": "..."}). Example: ${JSON.stringify(NATIVE_PATCH_EXAMPLE)}`,
    '- Use write_artifact/create_marker only for Wavemill-owned artifacts under the feature directory.',
    '- Use run_tests/run_format for verification and formatting commands inside the worktree.',
    '- Use git_add/git_commit to commit intended changed files before completion.',
    `- Prefer .coding-complete when full verification passes; otherwise write ${input.blockedCompletionPath} only when implementation is complete, scoped checks passed, changes are committed, and remaining blockers are unrelated or environmental.`,
  ].join('\n');
}

function buildUserPrompt(options: {
  issue: string;
  slug: string;
  title?: string;
  branch?: string;
  baseBranch?: string;
  issueContext?: string;
  planPath: string;
  taskPacketPath: string;
  taskPacket?: string;
  planText?: string;
}): string {
  return [
    `Issue: ${options.issue}`,
    `Slug: ${options.slug}`,
    `Title: ${options.title || options.issue}`,
    `Branch: ${options.branch || ''}`,
    `Base branch: ${options.baseBranch || ''}`,
    '',
    options.issueContext ? `Issue Context:\n${options.issueContext.trim()}\n` : '',
    `Plan path: ${options.planPath}`,
    options.planText ? `Plan:\n${options.planText.trim()}\n` : '',
    `Task packet path: ${options.taskPacketPath}`,
    options.taskPacket ? `Task Packet:\n${options.taskPacket.trim()}\n` : '',
    'Implement the plan, verify, commit intended changes, then write the appropriate coding completion artifact.',
  ].filter(Boolean).join('\n');
}

function readOptional(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
  } catch {
    return undefined;
  }
}

function findFinalAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message as { role?: string }).role !== 'assistant') continue;
    const errorMessage = (message as AgentTurn).errorMessage?.trim();
    if (errorMessage) return errorMessage;
  }
  return '';
}

function loadCodingArtifacts(featureDir: string, trackerCommitCount: number): CodingArtifacts {
  const resultPath = join(featureDir, '.coding-result.json');
  const existing = readOptional(resultPath);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      const validation = validateCodingArtifacts(parsed);
      if (validation.ok) {
        return validation.value;
      }
    } catch {
      // Fall through to minimal derived artifact.
    }
  }

  return {
    type: 'coding',
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commitCount: trackerCommitCount,
  };
}

function removeAgentCodingArtifactBeforeStageResult(featureDir: string): void {
  const resultPath = join(featureDir, '.coding-result.json');
  const existing = readOptional(resultPath);
  if (!existing) {
    return;
  }
  try {
    const validation = validateCodingArtifacts(JSON.parse(existing) as unknown);
    if (validation.ok) {
      rmSync(resultPath, { force: true });
    }
  } catch {
    // Malformed result files should be left in place so updateStageResult can
    // surface its existing diagnostics and replace them atomically.
  }
}

async function inspectCompletion(input: {
  featureDir: string;
  model: string;
  trackerCommitCount: number;
  stopReason: string;
  mutationFailures: MutationFailureSnapshot;
  wtDir: string;
}): Promise<'complete' | 'blocked'> {
  const markerPath = join(input.featureDir, '.coding-complete');
  if (existsSync(markerPath)) {
    rmSync(getNoMarkerHandoffPath(input.featureDir), { force: true });
    const parsed = parseCodingComplete(readFileSync(markerPath, 'utf-8'));
    if (!parsed.ok) {
      throw new Error(`Native coding wrote invalid .coding-complete: ${parsed.errors.map((error) => error.message).join('; ')}`);
    }
    const artifacts = loadCodingArtifacts(input.featureDir, input.trackerCommitCount);
    removeAgentCodingArtifactBeforeStageResult(input.featureDir);
    await updateStageResult(input.featureDir, 'coding', {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      agent: 'native',
      model: input.model,
      notes: `Native coding completed with ${parsed.value.confidence} confidence`,
      artifacts,
      failureReason: null,
    });
    return 'complete';
  }

  const blockedPath = getBlockedCompletionPath(input.featureDir);
  if (existsSync(blockedPath)) {
    rmSync(getNoMarkerHandoffPath(input.featureDir), { force: true });
    const blocked = await readBlockedCompletion(blockedPath);
    if (!blocked.ok) {
      throw new Error(`Native coding wrote invalid .coding-blocked-completion.json: ${blocked.message}`);
    }
    const artifacts = loadCodingArtifacts(input.featureDir, input.trackerCommitCount);
    removeAgentCodingArtifactBeforeStageResult(input.featureDir);
    await updateStageResult(input.featureDir, 'coding', {
      status: 'running',
      finishedAt: null,
      agent: 'native',
      model: input.model,
      notes: 'Native coding produced a blocked-completion handoff for monitor recovery',
      artifacts,
      failureReason: null,
    });
    return 'blocked';
  }

  const handoff = buildNoMarkerHandoff({
    stopReason: input.stopReason,
    model: input.model,
    mutationFailureCount: input.mutationFailures.count,
    lastMutationFailure: input.mutationFailures.last,
  });
  let handoffPath = getNoMarkerHandoffPath(input.featureDir);
  try {
    handoffPath = writeNoMarkerHandoff(input.featureDir, handoff);
  } catch {
    // Best-effort artifact; preserve the enriched terminal failure below.
  }

  let message = NO_MARKER_FAILURE_PREFIX;
  if (input.mutationFailures.last) {
    const failure = input.mutationFailures.last;
    message += `. Last mutation tool failure: ${failure.tool} ${failure.error}: ${failure.message}`;
  }
  message += `. Structured handoff: ${relative(input.wtDir, handoffPath)}.`;
  throw new Error(message);
}

interface MutationFailureSnapshot {
  count: number;
  last: CodingMutationFailure | null;
}

function createMutationFailureTracker() {
  let count = 0;
  let last: CodingMutationFailure | null = null;
  const handledToolCallIds = new Set<string>();

  return {
    record(toolName: string, result: unknown, toolCallId?: string): void {
      if (toolCallId && handledToolCallIds.has(toolCallId)) {
        return;
      }
      const failure = extractMutationFailure(toolName, result);
      if (!failure) {
        return;
      }
      if (toolCallId) {
        handledToolCallIds.add(toolCallId);
      }
      count += 1;
      last = failure;
    },
    recordBeforeToolCall(toolCall: unknown, args: unknown): void {
      if (!isRecord(toolCall) || toolCall.name !== 'apply_patch' || typeof toolCall.id !== 'string') {
        return;
      }
      if (handledToolCallIds.has(toolCall.id)) {
        return;
      }
      const patch = isRecord(args) ? args.patch : undefined;
      const validation = validateNativePatch(patch);
      if (validation.ok) {
        return;
      }
      handledToolCallIds.add(toolCall.id);
      count += 1;
      last = {
        tool: 'apply_patch',
        error: 'invalid_patch',
        message: 'Patch payload did not match the NativePatch contract.',
        retryHint: 'Fix the listed schema errors and retry; follow the valid example in this message.',
        diagnostics: truncateTrackedValue(validation.errors) as NativePatchValidationError[],
      };
    },
    recordEvent(event: unknown): void {
      if (!isRecord(event) || event.type !== 'tool_execution_end' || typeof event.toolName !== 'string') {
        return;
      }
      this.record(event.toolName, event.result, typeof event.toolCallId === 'string' ? event.toolCallId : undefined);
    },
    snapshot(): MutationFailureSnapshot {
      return { count, last };
    },
  };
}

function extractMutationFailure(toolName: string, result: unknown): CodingMutationFailure | null {
  if (!MUTATION_FAILURE_TOOLS.has(toolName)) {
    return null;
  }
  const details = isRecord(result) ? result.details : undefined;
  if (isRecord(details) && details.ok === false) {
    const normalizedError = normalizeFailureError(details.error);
    const message = typeof details.message === 'string'
      ? details.message
      : normalizedError.message || JSON.stringify(details.error ?? 'tool failed');
    const retryHint = typeof details.retryHint === 'string' ? truncateTrackedText(details.retryHint) : undefined;

    return {
      tool: toolName,
      error: truncateTrackedText(normalizedError.code),
      message: truncateTrackedText(message),
      ...(retryHint ? { retryHint } : {}),
      ...(Object.prototype.hasOwnProperty.call(details, 'diagnostics')
        ? { diagnostics: truncateTrackedValue(details.diagnostics) }
        : {}),
    };
  }

  const contentText = extractToolContentText(result);
  if (!contentText) {
    return null;
  }
  const patchDiagnostics = toolName === 'apply_patch' && contentText.includes('NativePatch contract')
    ? parseNativePatchDiagnostics(contentText)
    : [];
  return {
    tool: toolName,
    error: toolName === 'apply_patch' && contentText.includes('NativePatch contract') ? 'invalid_patch' : 'tool_error',
    message: truncateTrackedText(firstNonEmptyLine(contentText)),
    ...(patchDiagnostics.length > 0 ? { diagnostics: patchDiagnostics } : {}),
  };
}

function extractToolContentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

function parseNativePatchDiagnostics(text: string): Array<{ path: string; message: string }> {
  const diagnostics: Array<{ path: string; message: string }> = [];
  for (const line of text.split('\n')) {
    const match = /^- (\$[^:]+): (.+)$/.exec(line.trim());
    if (match) {
      diagnostics.push({ path: match[1]!, message: match[2]! });
    }
  }
  return diagnostics;
}

function firstNonEmptyLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? text;
}

function normalizeFailureError(error: unknown): { code: string; message: string } {
  if (typeof error === 'string') {
    return { code: error, message: '' };
  }
  if (isRecord(error)) {
    const code = typeof error.code === 'string' ? error.code : 'tool_error';
    const message = typeof error.message === 'string' ? error.message : '';
    return { code, message };
  }
  return { code: 'tool_error', message: '' };
}

function truncateTrackedValue(value: unknown): unknown {
  const serialized = truncateTrackedText(safeStringify(value));
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

function truncateTrackedText(text: string): string {
  return text.length > TRACKED_TEXT_LIMIT ? `${text.slice(0, TRACKED_TEXT_LIMIT)}...[truncated]` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function launchNativeCoding(options: LaunchNativeCodingOptions): Promise<LaunchNativeCodingResult> {
  const featureDir = options.featureDir ?? join(options.wtDir, 'features', options.slug);
  const taskPacketPath = options.taskPacketPath ?? join(featureDir, 'task-packet.md');
  const planPath = options.planPath ?? join(featureDir, 'plan.md');
  const hookPath = options.hookPath ?? defaultHookPath(options.session, options.issue);
  const codeDepth = options.codeDepth ?? 'medium';
  const operatingMode = options.operatingMode ?? 'normal';

  mkdirSync(featureDir, { recursive: true });
  rmSync(getNoMarkerHandoffPath(featureDir), { force: true });
  writeHookStatus(hookPath, 'working', 'launch_native_coding', options.loopModelOverride?.name ?? 'native', 'native');
  writeTextStatus(options.session, options.issue, 'native coding starting');

  try {
    const tracker = createIntendedFileTracker();
    const mutationFailureTracker = createMutationFailureTracker();
    const descriptors = [
      ...createReadOnlyTools(options.wtDir),
      ...createGitTools(options.wtDir),
      ...createCommandTools(options.wtDir),
      ...createCodingMutationTools(options.wtDir, { phase: 'coding' }),
      ...createGitCommitTools(options.wtDir, { tracker }),
      ...(options.extraDescriptors ?? []),
    ];
    const registry = createToolRegistry(descriptors);
    const registryMetadata = options.registryMetadataOverride ?? registry.list();

    const providerEntries = options.providerEntries
      ?? resolveNativeAgentProviders(options.repoDir, { phase: 'coding' });
    const readyProviders = providerEntries.filter(
      (entry): entry is ReadyNativeProviderEntry => entry.status === 'ready',
    );
    const readyProvider = selectReadyProvider(readyProviders, options.resolvedModel);

    if (options.resolvedModel?.trim() && readyProviders.length > 0 && !readyProvider && !options.loopModelOverride) {
      throw new Error(
        `Native coding requested model "${options.resolvedModel.trim()}", but no ready native provider matched it. `
        + `Ready providers: ${formatReadyProviderList(readyProviders)}. `
        + 'Run wavemill native-agent models report --json to inspect current artifact eligibility.',
      );
    }
    if (!readyProvider && !options.loopModelOverride) {
      throw new Error(buildNativeProviderResolutionFailureMessage('coding', providerEntries, 'patch'));
    }

    const apiKey = readyProvider ? getNativeProviderApiKey(readyProvider) : undefined;
    const model = options.loopModelOverride ?? {
      ...readyProvider!.model,
      headers: {
        ...(readyProvider!.model.headers ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    };
    const modelName = model.name ?? model.id;
    const transcriptPath = makeTranscriptPath(options.repoDir, options.session, options.issue);
    const transcriptWriter = new TranscriptWriter({
      sessionId: `${options.session}-coding-${options.issue}`,
      model: modelName,
      api: model.api,
      provider: model.provider,
      worktreePath: options.wtDir,
      gitBranch: options.branch,
      path: transcriptPath,
    });

    const { content: promptTemplate, promptRef } = loadCodingPrompt(options.repoDir);
    registerAndRecordNativeProvenance({
      sessionId: options.session,
      phase: 'coding',
      provider: model.provider,
      model: modelName,
      api: model.api,
      tools: registryMetadata.map((meta) => ({ name: meta.name, class: meta.class })),
      promptRef,
      repoDir: options.repoDir,
    });

    await updateStageResult(featureDir, 'coding', {
      status: 'running',
      finishedAt: null,
      agent: 'native',
      model: modelName,
      notes: 'Native coding running',
      failureReason: null,
    });

    const context: AgentContext = {
      systemPrompt: renderCodingSystemPrompt({
        template: promptTemplate,
        codeDepth,
        operatingMode,
        featureDir,
        planPath,
        slug: options.slug,
        blockedCompletionPath: relative(options.wtDir, getBlockedCompletionPath(featureDir)),
      }),
      messages: [{
        role: 'user',
        content: buildUserPrompt({
          issue: options.issue,
          slug: options.slug,
          title: options.title,
          branch: options.branch,
          baseBranch: options.baseBranch,
          issueContext: options.issueContext,
          planPath,
          taskPacketPath,
          planText: readOptional(planPath),
          taskPacket: readOptional(taskPacketPath),
        }),
        timestamp: 0,
      }],
      tools: toPiTools(descriptors),
    };

    writeHookStatus(hookPath, 'working', 'run_native_model', modelName, 'native');
    const result = await runWavemillLoop({
      model,
      context,
      convertToLlm: (messages) => messages as unknown as Message[],
      signal: options.signal,
      beforeToolCall: async (toolContext) => {
        mutationFailureTracker.recordBeforeToolCall(toolContext.toolCall, toolContext.args);
        return undefined;
      },
      afterToolCall: async (toolContext, signal) => {
        await intendedFilesAfterToolCall(toolContext, tracker);

        const commandResult = await commandToolsAfterToolCall(toolContext);
        if (commandResult?.isError) return commandResult;

        const gitResult = await gitAfterToolCall(toolContext);
        if (gitResult?.isError) return gitResult;

        const gitMutationResult = await gitMutationAfterToolCall(toolContext);
        if (gitMutationResult?.isError) return gitMutationResult;

        return codingMutationAfterToolCall(toolContext);
      },
      toolPolicy: {
        phase: 'coding',
        worktreePath: options.wtDir,
        registry: registryMetadata,
        config: {
          pathFieldsByTool: {
            ...READ_ONLY_PATH_FIELDS,
            ...gitToolPolicyConfig.pathFieldsByTool,
            ...gitMutationToolPolicyConfig.pathFieldsByTool,
            ...codingMutationPolicyConfig.pathFieldsByTool,
          },
        },
      },
      onEvent: (event) => {
        mutationFailureTracker.recordEvent(event);
        transcriptWriter.handleEvent(event);
      },
    });

    const providerError = findFinalAssistantErrorMessage(result.messages);
    if (providerError) {
      throw new Error(`Native coding failed: ${providerError}`);
    }

    const completion = await inspectCompletion({
      featureDir,
      model: modelName,
      trackerCommitCount: tracker.commitCount,
      stopReason: result.stopReason,
      mutationFailures: mutationFailureTracker.snapshot(),
      wtDir: options.wtDir,
    });
    writeHookStatus(hookPath, completion === 'complete' ? 'idle' : 'working', 'process_exit', completion, 'native');
    writeTextStatus(options.session, options.issue, completion === 'complete' ? 'coding complete' : 'coding blocked-completion');

    // Ensure the monitor has a compact result artifact even when the model only
    // used .coding-complete and skipped .coding-result.json.
    const resultPath = join(featureDir, '.coding-result.json');
    if (!existsSync(resultPath)) {
      const stageStatus = completion === 'complete' ? 'completed' : 'running';
      atomicWriteText(resultPath, JSON.stringify({
        stage: 'coding',
        status: stageStatus,
        agent: 'native',
        model: modelName,
      }, null, 2));
    }

    return {
      featureDir,
      hookPath,
      provider: model.provider,
      model: modelName,
      stopReason: result.stopReason,
      transcriptPath,
      completion,
    };
  } catch (error) {
    const message = (error as Error).message;
    await updateStageResult(featureDir, 'coding', {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      agent: 'native',
      model: options.loopModelOverride?.name ?? options.resolvedModel ?? '',
      notes: `Native coding failed: ${message}`,
      failureReason: message,
    });
    writeHookStatus(hookPath, 'error', 'process_exit', message, 'native');
    writeTextStatus(options.session, options.issue, 'native coding error');
    throw error;
  }
}

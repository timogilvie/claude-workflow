/**
 * Key-aware native agent smoke: dry-run and live read-only loop validation.
 *
 * - Dry-run mode: proves provider resolution, model selection, and tool exposure
 *   without external API calls or provider keys.
 * - Live mode: runs a minimal real provider round-trip when the requested
 *   provider's API key is present; emits a structured skip (exit 0) when the
 *   key is absent.
 *
 * Callers should import the typed result and pass it to their formatters.
 * API keys are never written into the result object or the transcript JSONL.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Message } from './messages.ts';
import type { AgentContext } from './loop.ts';
import { runWavemillLoop, type WavemillLoopConfig } from './loop.ts';
import { TranscriptWriter, type TranscriptSessionStarted, type TranscriptSessionEnded } from './transcript.ts';
import {
  resolveNativeAgentProviders,
  getNativeProviderApiKey,
  OPENAI_NATIVE_PROVIDER,
  OPENROUTER_NATIVE_PROVIDER,
  OPENAI_DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODELS,
  type ReadyNativeProviderEntry,
  type UnavailableNativeProviderEntry,
  type SkippedNativeProviderEntry,
  type ResolvedNativeProviderEntry,
} from './providers.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { createGitTools, gitAfterToolCall } from './tools/git.ts';
import { createToolRegistry } from './tools/registry.ts';
import { toPiAgentTool } from './tools/pi-adapter.ts';
import type { NativeAgentConfig } from '../config.ts';
import type { ModelCapabilities, ModelRegistry, PiCompatFlags } from '../model-registry.ts';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SMOKE_PROVIDERS = [
  OPENAI_NATIVE_PROVIDER,
  OPENROUTER_NATIVE_PROVIDER,
] as const;

export const SMOKE_PHASES = ['planning'] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SmokeProvider = typeof SMOKE_PROVIDERS[number];
export type SmokePhase = typeof SMOKE_PHASES[number];

export interface NativeSmokeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnsCompleted: number;
  toolCallsExecuted: number;
  wallClockMs: number;
}

export interface NativeSmokeResult {
  /** Whether the smoke ran to completion (ok) or was skipped due to a missing key. */
  outcome: 'ok' | 'skipped';
  /** Human-readable skip reason when outcome === 'skipped'. */
  skipReason?: string;
  provider: SmokeProvider;
  modelId: string;
  phase: SmokePhase;
  /** Names of tools exposed to the agent in the requested phase. */
  exposedTools: string[];
  /** Absolute path to the written transcript JSONL (dry-run writes a synthetic stub). */
  transcriptPath: string;
  /** Environment variable name used to look up the provider API key. */
  apiKeyEnv: string;
  /** Token and turn usage from a live run; absent in dry-run and skipped outcomes. */
  usage?: NativeSmokeUsage;
}

export interface RunNativeSmokeOptions {
  provider: SmokeProvider;
  phase: SmokePhase;
  /** Repository directory. Defaults to process.cwd(). */
  repoDir?: string;
  /** Environment variable overrides (used in tests to inject keys without touching process.env). */
  env?: Record<string, string | undefined>;
  /** Directory to write transcript files. Defaults to os.tmpdir(). */
  transcriptDir?: string;
  /** Session identifier written into the transcript; defaults to a time-based value. */
  sessionId?: string;
  /**
   * Test-only: override the model config used in the live loop.
   *
   * When set, bypasses provider entry model construction and uses this config directly.
   * Allows tests to inject a scripted Pi provider (via registerScriptedPiProvider) without
   * real network access. Do not use in production code paths.
   */
  _modelOverride?: WavemillLoopConfig['model'];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function providerApiType(provider: SmokeProvider): string {
  return provider === OPENAI_NATIVE_PROVIDER ? 'openai-responses' : 'openai-completions';
}

/**
 * Resolve a provider entry, falling back to a default config if the provider
 * has no explicit block in .wavemill-config.json. This allows the smoke to
 * produce correct model IDs and apiKeyEnv values even on unconfigured repos.
 */
function resolveProviderEntry(
  provider: SmokeProvider,
  repoDir: string | undefined,
  env?: Record<string, string | undefined>,
): ResolvedNativeProviderEntry {
  const existingEntries = resolveNativeAgentProviders(repoDir, { env });
  const existing = existingEntries.find((e) => e.providerName === provider);
  if (existing) {
    return existing;
  }

  // No explicit config for this provider — synthesize with defaults so dry-run
  // and live can still report correct model and env var names.
  const defaultConfig: NativeAgentConfig = {
    providers: { [provider]: {} },
  };
  const defaultEntries = resolveNativeAgentProviders(defaultConfig, { env, repoDir });
  const fallback = defaultEntries.find((e) => e.providerName === provider);
  if (!fallback) {
    // Should not happen — we just added the provider to the config.
    throw new Error(`Failed to resolve default entry for provider "${provider}"`);
  }
  return fallback;
}

/**
 * Build a minimal compat registry for a smoke model so that assertToolCompat
 * in runWavemillLoop can validate tool/provider compatibility. Smoke models
 * (gpt-4o, openai/gpt-4o-mini, etc.) are not guaranteed to be in the global
 * DEFAULT_MODEL_REGISTRY, so we register them here with their derived capability.
 */
function buildSmokeCompatRegistry(
  modelId: string,
  provider: SmokeProvider,
): ModelRegistry {
  const piTransportKind = providerApiType(provider) as 'openai-responses' | 'openai-completions';
  const compatFlags: PiCompatFlags | undefined =
    provider === OPENROUTER_NATIVE_PROVIDER ? { thinkingFormat: 'openrouter' } : undefined;
  return {
    models: {
      [modelId]: {
        nativeCapability: {
          readOnlyNative: 'certified',
          nativeProvider: provider,
          piTransportKind,
          ...(compatFlags ? { compatFlags } : {}),
        },
      } as unknown as ModelCapabilities,
    },
    ladders: {},
  };
}

function buildSmokeToolRegistry(worktreePath: string) {
  const readOnlyDescriptors = createReadOnlyTools(worktreePath);
  const gitDescriptors = createGitTools(worktreePath);
  return createToolRegistry([...readOnlyDescriptors, ...gitDescriptors]);
}

function makeTranscriptPath(
  prefix: string,
  sessionId: string,
  transcriptDir: string | undefined,
): string {
  const dir = transcriptDir ?? tmpdir();
  return join(dir, `${prefix}-${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

/**
 * Dry-run mode: validates provider resolution, model selection, and read-only
 * tool exposure without making any external API calls.
 *
 * Produces a minimal synthetic transcript to prove the writer integration and
 * returns a stable NativeSmokeResult shape identical to the live path.
 */
export async function runNativeAgentDryRun(
  options: RunNativeSmokeOptions,
): Promise<NativeSmokeResult> {
  const { provider, phase, repoDir, env, transcriptDir } = options;

  const entry = resolveProviderEntry(provider, repoDir, env);

  // Build registry bound to repoDir (or cwd) to report real tool names.
  // In dry-run we never execute any tools, so the path just needs to be valid.
  const worktreePath = repoDir ?? process.cwd();
  const registry = buildSmokeToolRegistry(worktreePath);
  const exposedTools = registry.list({ phase }).map((m) => m.name);

  // Write a minimal synthetic transcript that matches the native JSONL shape.
  const sessionId = options.sessionId ?? `smoke-dry-${provider}-${phase}`;
  const transcriptPath = makeTranscriptPath('native-smoke-dry', sessionId, transcriptDir);
  mkdirSync(dirname(transcriptPath), { recursive: true });

  const api = providerApiType(provider);
  const now = Date.now();

  const writer = new TranscriptWriter({
    sessionId,
    model: entry.modelId,
    api,
    provider,
    path: transcriptPath,
  });

  const sessionStarted: TranscriptSessionStarted = {
    seq: 0,
    sessionId,
    timestamp: now,
    type: 'session_started',
    model: entry.modelId,
    api,
    provider,
  };
  const sessionEnded: TranscriptSessionEnded = {
    seq: 1,
    sessionId,
    timestamp: now,
    type: 'session_ended',
    messageCount: 0,
  };

  writer.write(sessionStarted);
  writer.write(sessionEnded);

  return {
    outcome: 'ok',
    provider,
    modelId: entry.modelId,
    phase,
    exposedTools,
    transcriptPath,
    apiKeyEnv: entry.apiKeyEnv,
  };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

/**
 * Live mode: runs a minimal real provider round-trip through the native loop.
 *
 * Returns a skipped result (exit 0) when the provider's API key is absent.
 * Throws on genuine runtime failures so the caller can exit non-zero.
 */
export async function runNativeAgentLive(
  options: RunNativeSmokeOptions,
): Promise<NativeSmokeResult> {
  const { provider, phase, repoDir, env, transcriptDir } = options;

  const entry = resolveProviderEntry(provider, repoDir, env);

  if (entry.status !== 'ready') {
    const reason = (entry as UnavailableNativeProviderEntry | SkippedNativeProviderEntry).reason;
    return {
      outcome: 'skipped',
      skipReason: reason,
      provider,
      modelId: entry.modelId,
      phase,
      exposedTools: [],
      transcriptPath: '',
      apiKeyEnv: entry.apiKeyEnv,
    };
  }

  const readyEntry = entry as ReadyNativeProviderEntry;
  const apiKey = getNativeProviderApiKey(readyEntry);
  if (!apiKey) {
    // Defensive: should not happen when status === 'ready'.
    return {
      outcome: 'skipped',
      skipReason: `${readyEntry.apiKeyEnv} resolved to an empty value`,
      provider,
      modelId: readyEntry.modelId,
      phase,
      exposedTools: [],
      transcriptPath: '',
      apiKeyEnv: readyEntry.apiKeyEnv,
    };
  }

  const worktreePath = repoDir ?? process.cwd();
  const registry = buildSmokeToolRegistry(worktreePath);
  const exposedTools = registry.list({ phase }).map((m) => m.name);
  const piTools = registry.getTools({ phase }).map((d) => toPiAgentTool(d));

  const sessionId = options.sessionId ?? `smoke-live-${provider}-${Date.now()}`;
  const transcriptPath = makeTranscriptPath('native-smoke-live', sessionId, transcriptDir);

  const api = String(readyEntry.model.api);
  const writer = new TranscriptWriter({
    sessionId,
    model: readyEntry.modelId,
    api: options._modelOverride?.api ?? api,
    provider,
    path: transcriptPath,
  });

  // Build model config with Authorization header so Pi can authenticate.
  // _modelOverride lets tests inject a scripted Pi provider without network access.
  const modelConfig: WavemillLoopConfig['model'] = options._modelOverride ?? {
    id: readyEntry.model.id,
    name: readyEntry.model.name,
    api,
    provider: String(readyEntry.model.provider),
    baseUrl: readyEntry.model.baseUrl,
    headers: {
      ...(readyEntry.model.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
    compat: readyEntry.model.compat as unknown,
  };

  const context: AgentContext = {
    systemPrompt: [
      'You are a read-only planning assistant performing a native agent smoke test.',
      'Your only job is to list the files in the worktree root using the list_files tool, then stop.',
      'Do not modify any files.',
    ].join('\n'),
    messages: [{
      role: 'user' as const,
      content: 'List the files in the worktree root to verify read access, then stop.',
      timestamp: 0,
    }],
    tools: piTools,
  };

  const loopConfig: WavemillLoopConfig = {
    model: modelConfig,
    context,
    convertToLlm: (messages) => messages as unknown as Message[],
    afterToolCall: gitAfterToolCall,
    toolPolicy: {
      phase: 'planning',
      worktreePath,
      registry: registry.list(),
      config: { pathFieldsByTool: READ_ONLY_PATH_FIELDS },
    },
    onEvent: (event) => writer.handleEvent(event),
    budget: {
      maxTurns: 3,
      maxToolCalls: 5,
      maxWallClockMs: 60_000,
    },
    compatRegistry: buildSmokeCompatRegistry(readyEntry.modelId, provider),
  };

  const loopResult = await runWavemillLoop(loopConfig);

  if (loopResult.stopReason === 'error') {
    throw new Error(
      `Native agent live smoke failed: loop exited with stopReason "error"`,
    );
  }

  const totalTokens = loopResult.totalInputTokens + loopResult.totalOutputTokens;
  if (loopResult.turnsCompleted === 0) {
    throw new Error(
      'Native agent live smoke failed: provider did not complete any turns.',
    );
  }

  if (loopResult.toolCallsExecuted === 0) {
    throw new Error(
      'Native agent live smoke failed: provider did not execute the required read-only tool call.',
    );
  }

  if (totalTokens === 0) {
    throw new Error(
      'Native agent live smoke failed: provider returned zero usage, so cost capture cannot be certified.',
    );
  }

  return {
    outcome: 'ok',
    provider,
    modelId: readyEntry.modelId,
    phase,
    exposedTools,
    transcriptPath,
    apiKeyEnv: readyEntry.apiKeyEnv,
    usage: {
      inputTokens: loopResult.totalInputTokens,
      outputTokens: loopResult.totalOutputTokens,
      totalTokens,
      turnsCompleted: loopResult.turnsCompleted,
      toolCallsExecuted: loopResult.toolCallsExecuted,
      wallClockMs: loopResult.wallClockMs,
    },
  };
}

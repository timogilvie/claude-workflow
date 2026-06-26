import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Message } from './messages.ts';
import { registerScriptedPiProvider } from './provider.ts';
import { runWavemillLoop, type AgentContext, type WavemillLoopConfig } from './loop.ts';
import {
  getNativeProviderApiKey,
  OPENAI_DEFAULT_MODELS,
  OPENAI_NATIVE_PROVIDER,
  OPENROUTER_DEFAULT_MODELS,
  OPENROUTER_NATIVE_PROVIDER,
  resolveNativeAgentProviders,
  type ReadyNativeProviderEntry,
  type ResolvedNativeProviderEntry,
  type UnavailableNativeProviderEntry,
  type SkippedNativeProviderEntry,
} from './providers.ts';
import { codingLifecycleSessionTurns } from './fixtures/coding-lifecycle-session.ts';
import { TranscriptWriter } from './transcript.ts';
import { createCodingMutationTools, codingMutationAfterToolCall, codingMutationPolicyConfig } from './tools/mutation-tools.ts';
import { toPiAgentTool } from './tools/pi-adapter.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { createToolRegistry } from './tools/registry.ts';
import type { ModelCapabilities, ModelRegistry, PiCompatFlags } from '../model-registry.ts';
import type { NativeAgentConfig } from '../config.ts';
import {
  assertPatchCodingCertificationCoverage,
  computeSmokeSuiteRevision,
  type PatchCodingCertification,
  type PatchCodingProviderRun,
} from './patch-coding-certification.ts';

export const SMOKE_CODING_PROVIDERS = [
  OPENAI_NATIVE_PROVIDER,
  OPENROUTER_NATIVE_PROVIDER,
] as const;

export type PatchCodingSmokeProvider = typeof SMOKE_CODING_PROVIDERS[number];
export type PatchCodingSmokeOutcome = 'ok' | 'skipped';

export interface PatchCodingSmokeResult {
  outcome: PatchCodingSmokeOutcome;
  skipReason?: string;
  providersRun: PatchCodingProviderRun[];
  certification: PatchCodingCertification | null;
}

interface RunPatchCodingSmokeOptions {
  repoDir?: string;
  env?: Record<string, string | undefined>;
  transcriptDir?: string;
}

interface CodingSmokeProviderResult extends PatchCodingProviderRun {
  transcriptPath: string;
}

let apiSeq = 0;

function uniqueApi(prefix: string): string {
  apiSeq += 1;
  return `${prefix}-${apiSeq}`;
}

function createFixtureRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'patch-coding@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Patch Coding Smoke'], { stdio: 'pipe' });

  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(repoDir, 'features', 'native-patch-coding-smoke'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'app.ts'), "export const message = 'before';\n", 'utf-8');
  writeFileSync(join(repoDir, 'features', 'native-patch-coding-smoke', 'task-packet.md'), '# Task Packet\n', 'utf-8');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'fixture'], { stdio: 'pipe' });
  return repoDir;
}

function buildCompatRegistry(
  modelId: string,
  provider: PatchCodingSmokeProvider,
): ModelRegistry {
  const piTransportKind = provider === OPENAI_NATIVE_PROVIDER ? 'openai-responses' : 'openai-completions';
  const compatFlags: PiCompatFlags | undefined =
    provider === OPENROUTER_NATIVE_PROVIDER ? { thinkingFormat: 'openrouter' } : undefined;

  return {
    models: {
      [modelId]: {
        nativeCapability: {
          nativeProvider: provider,
          piTransportKind,
          readOnlyNative: 'certified',
          ...(compatFlags ? { compatFlags } : {}),
        },
      } as unknown as ModelCapabilities,
    },
    ladders: {},
  };
}

function buildSmokeSuiteRevision(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const fixtureFiles = [
    resolve(moduleDir, 'fixtures/coding-lifecycle-session.ts'),
    resolve(moduleDir, 'coding-artifacts.ts'),
    resolve(moduleDir, 'tools/mutation-tools.ts'),
    resolve(moduleDir, 'tools/apply-patch-tool.ts'),
  ];
  return computeSmokeSuiteRevision(fixtureFiles);
}

function buildTooling(repoDir: string) {
  const registry = createToolRegistry([
    ...createReadOnlyTools(repoDir),
    ...createCodingMutationTools(repoDir, { phase: 'coding' }),
  ]);

  return {
    registry,
    tools: registry.getTools({ phase: 'coding' }).map((tool) => toPiAgentTool(tool)),
  };
}

async function runCodingLoop(
  repoDir: string,
  provider: PatchCodingSmokeProvider,
  model: WavemillLoopConfig['model'],
  transcriptDir?: string,
): Promise<CodingSmokeProviderResult> {
  const { registry, tools } = buildTooling(repoDir);
  const sessionId = `patch-coding-smoke-${provider}-${Date.now()}`;
  const transcriptPath = join(transcriptDir ?? tmpdir(), `${sessionId}.jsonl`);
  mkdirSync(dirname(transcriptPath), { recursive: true });

  const writer = new TranscriptWriter({
    sessionId,
    model: model.name,
    api: model.api,
    provider: String(model.provider),
    path: transcriptPath,
  });

  const context: AgentContext = {
    systemPrompt: 'You are a coding agent. Apply the requested patch and write completion artifacts.',
    messages: [{
      role: 'user',
      content: 'Read src/app.ts, replace before with after, create the completion marker, write the coding artifact, then stop.',
      timestamp: 0,
    }],
    tools,
  };

  const result = await runWavemillLoop({
    model,
    context,
    convertToLlm: (messages) => messages as unknown as Message[],
    afterToolCall: codingMutationAfterToolCall,
    toolPolicy: {
      phase: 'coding',
      worktreePath: repoDir,
      registry: registry.list(),
      config: {
        pathFieldsByTool: {
          ...READ_ONLY_PATH_FIELDS,
          ...codingMutationPolicyConfig.pathFieldsByTool,
        },
      },
    },
    onEvent: (event) => writer.handleEvent(event),
    budget: {
      maxTurns: 10,
      maxToolCalls: 8,
      maxWallClockMs: 60_000,
    },
    compatRegistry: buildCompatRegistry(model.name, provider),
  });

  const usageTokens = result.totalInputTokens + result.totalOutputTokens;
  if (result.stopReason === 'error') {
    throw new Error(`Patch coding smoke failed for ${provider}/${model.name}: loop exited with stopReason "error"`);
  }
  if (result.turnsCompleted === 0) {
    throw new Error(`Patch coding smoke failed for ${provider}/${model.name}: provider did not complete any turns`);
  }
  if (result.toolCallsExecuted < 1) {
    throw new Error(`Patch coding smoke failed for ${provider}/${model.name}: provider did not execute any tool calls`);
  }
  if (usageTokens <= 0) {
    throw new Error(`Patch coding smoke failed for ${provider}/${model.name}: provider returned zero usage`);
  }

  return {
    provider,
    model: model.name,
    usageTokens,
    toolCalls: result.toolCallsExecuted,
    transcriptPath,
  };
}

function certificationFromProviders(providersRun: PatchCodingProviderRun[]): PatchCodingCertification {
  const certification: PatchCodingCertification = {
    schemaVersion: '1',
    smokeSuiteRevision: buildSmokeSuiteRevision(),
    certifiedAt: new Date().toISOString(),
    providers: providersRun,
  };

  const coverage = assertPatchCodingCertificationCoverage(certification);
  if (!coverage.ok) {
    throw new Error(`Patch coding certification coverage failed: ${coverage.reason}`);
  }

  return certification;
}

function defaultProviderConfig(provider: PatchCodingSmokeProvider): NativeAgentConfig {
  return {
    providers: {
      [provider]: {},
    },
  };
}

function resolveProviderEntry(
  provider: PatchCodingSmokeProvider,
  repoDir?: string,
  env?: Record<string, string | undefined>,
): ResolvedNativeProviderEntry {
  const existing = resolveNativeAgentProviders(repoDir, {
    env,
    repoDir,
    phase: 'planning',
    certificationMode: true,
  }).find((entry) => entry.providerName === provider);

  if (existing) {
    return existing;
  }

  const fallback = resolveNativeAgentProviders(defaultProviderConfig(provider), {
    env,
    repoDir,
    phase: 'planning',
    certificationMode: true,
  }).find((entry) => entry.providerName === provider);

  if (!fallback) {
    throw new Error(`Failed to resolve default patch coding provider entry for "${provider}"`);
  }

  return fallback;
}

export async function runPatchCodingSmokeDryRun(
  options: RunPatchCodingSmokeOptions = {},
): Promise<PatchCodingSmokeResult> {
  const providersRun: CodingSmokeProviderResult[] = [];

  for (const provider of SMOKE_CODING_PROVIDERS) {
    const repoDir = createFixtureRepo(`patch-coding-smoke-dry-${provider}-`);
    try {
      const modelId = provider === OPENAI_NATIVE_PROVIDER
        ? OPENAI_DEFAULT_MODELS[0]
        : OPENROUTER_DEFAULT_MODELS[0];
      const api = uniqueApi(`patch-coding-${provider}`);
      registerScriptedPiProvider({ api, turns: codingLifecycleSessionTurns });

      providersRun.push(await runCodingLoop(
        repoDir,
        provider,
        {
          id: `scripted:${api}`,
          name: modelId,
          api,
          provider: 'scripted',
        },
        options.transcriptDir,
      ));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }

  const certification = certificationFromProviders(
    providersRun.map(({ provider, model, usageTokens, toolCalls }) => ({
      provider,
      model,
      usageTokens,
      toolCalls,
    })),
  );

  return {
    outcome: 'ok',
    providersRun: certification.providers,
    certification,
  };
}

export async function runPatchCodingSmokeLive(
  options: RunPatchCodingSmokeOptions = {},
): Promise<PatchCodingSmokeResult> {
  const providersRun: CodingSmokeProviderResult[] = [];

  for (const provider of SMOKE_CODING_PROVIDERS) {
    const repoDir = createFixtureRepo(`patch-coding-smoke-live-${provider}-`);
    try {
      const entry = resolveProviderEntry(provider, options.repoDir, options.env);
      if (entry.status !== 'ready') {
        const reason = (entry as UnavailableNativeProviderEntry | SkippedNativeProviderEntry).reason;
        return {
          outcome: 'skipped',
          skipReason: `${provider}: ${reason}`,
          providersRun: [],
          certification: null,
        };
      }

      const readyEntry = entry as ReadyNativeProviderEntry;
      const apiKey = getNativeProviderApiKey(readyEntry);
      if (!apiKey) {
        return {
          outcome: 'skipped',
          skipReason: `${provider}: ${readyEntry.apiKeyEnv} resolved to an empty value`,
          providersRun: [],
          certification: null,
        };
      }

      providersRun.push(await runCodingLoop(
        repoDir,
        provider,
        {
          id: readyEntry.model.id,
          name: readyEntry.model.name,
          api: String(readyEntry.model.api),
          provider: String(readyEntry.model.provider),
          baseUrl: readyEntry.model.baseUrl,
          headers: {
            ...(readyEntry.model.headers ?? {}),
            Authorization: `Bearer ${apiKey}`,
          },
          compat: readyEntry.model.compat as unknown,
        },
        options.transcriptDir,
      ));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }

  const certification = certificationFromProviders(
    providersRun.map(({ provider, model, usageTokens, toolCalls }) => ({
      provider,
      model,
      usageTokens,
      toolCalls,
    })),
  );

  return {
    outcome: 'ok',
    providersRun: certification.providers,
    certification,
  };
}

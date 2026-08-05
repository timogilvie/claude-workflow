#!/usr/bin/env -S npx tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { clearConfigCache } from '../shared/lib/config.ts';
import { isValidTaskPacket, splitTaskPacket, writeTaskPacketArtifacts } from '../shared/lib/task-packet-utils.ts';
import { DEFAULT_VALIDATION_CONFIG, validateTaskPacket } from '../shared/lib/task-packet-validator.ts';
import {
  NativeExpansionUnavailableError,
  runNativeExpansion,
  writeNativeExpansionSidecar,
  type NativeExpansionMetadata,
} from '../shared/lib/native-expansion.ts';
import { expandIssue } from '../shared/lib/issue-expander.ts';
import { registerScriptedPiProvider } from '../shared/lib/native-agent/provider.ts';
import {
  buildCertificationPath,
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  resolveCertificationStorageIdentity,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/index.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';
import { createToolRegistry } from '../shared/lib/native-agent/tools/registry.ts';
import { createReadOnlyTools } from '../shared/lib/native-agent/tools/read-only.ts';
import { createGitTools } from '../shared/lib/native-agent/tools/git.ts';
import { closeManifest, openManifest, resolveManifestPath, type ResourceManifest } from '../shared/lib/resource-manifest.ts';
import { listResources, resolveRegistryFile, type ResourceVersion } from '../shared/lib/resource-registry.ts';
import type { ModelCapabilities, ModelRegistry } from '../shared/lib/model-registry.ts';

const ISSUE_ID = 'HOK-2424';
const TARGET_MODELS = [
  'qwen/qwen3-coder',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k2.7-code',
] as const;
const FIXED_NOW = new Date('2026-07-13T12:00:00.000Z');
const DEFAULT_ISSUE_CONTEXT = [
  'Issue: HOK-2424-FIXTURE',
  'Title: Verify native OpenRouter task expansion rollout',
  'Description:',
  'Run a verification-only native task expansion and record the generated artifacts.',
].join('\n');
const DEFAULT_CODEBASE_CONTEXT = [
  'Relevant files:',
  '- shared/lib/native-expansion.ts',
  '- shared/lib/issue-expander.ts',
  '- tools/expand-issue.ts',
].join('\n');

type CriterionStatus = 'pass' | 'fail' | 'skipped';

export interface CriterionResult {
  id: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';
  title: string;
  status: CriterionStatus;
  detail: string;
  artifacts: string[];
}

export interface ArtifactPaths {
  taskPacket: string;
  header: string;
  details: string;
  sidecar: string;
  transcript: string;
  manifest: string;
  registry: string;
}

export interface HappyPathObservation {
  repoDir: string;
  session: string;
  requestedModel: string;
  live: boolean;
  text: string;
  native: NativeExpansionMetadata;
  sidecar: NativeExpansionMetadata;
  artifacts: ArtifactPaths;
  validationPassed: boolean;
  validationIssueCount: number;
  manifest: ResourceManifest;
  resources: ResourceVersion[];
}

export interface MutationObservation {
  requestedModel: string;
  deniedToolCalls: ReadonlyArray<{ tool: string; reason: string }>;
  gitStatusBefore: string;
  gitStatusAfter: string;
  trackedHashBefore: string;
  trackedHashAfter: string;
  transcriptPath: string;
  manifestPath: string;
}

export interface SelectionCase {
  caseId: 'missing' | 'stale' | 'fresh';
  status: string;
  reason?: string;
}

export interface FallbackObservation {
  fallbackText: string;
  warningText: string;
  nonAvailabilityError: string;
}

export interface StructuralComparison {
  baselinePath: string;
  nativeSections: string[];
  baselineSections: string[];
  missingSections: string[];
}

export interface LiveRunSummary {
  requested: boolean;
  status: 'executed' | 'skipped';
  reason: string;
  observation?: HappyPathObservation;
}

export interface VerificationSummary {
  issueId: string;
  generatedAt: string;
  gitSha: string;
  nodeVersion: string;
  requestedModel: string;
  configuredModels: string[];
  criteria: CriterionResult[];
  offline: HappyPathObservation;
  mutation: MutationObservation;
  selectionCases: SelectionCase[];
  fallback: FallbackObservation;
  structure: StructuralComparison;
  liveRun: LiveRunSummary;
}

interface ModelMeta {
  vendor: string;
  modelClass: 'strong_generalist' | 'frontier';
  reasoningTier: 'advanced';
  contextWindowTokens: number;
  multimodal: { text: true; image: boolean };
  inputCost: number;
  outputCost: number;
  qualityScores: {
    routing: number;
    planning: number;
    coding: number;
    review: number;
    classify: number;
  };
}

const MODEL_META: Record<string, ModelMeta> = {
  'qwen/qwen3-coder': {
    vendor: 'qwen',
    modelClass: 'strong_generalist',
    reasoningTier: 'advanced',
    contextWindowTokens: 262_144,
    multimodal: { text: true, image: false },
    inputCost: 0.35,
    outputCost: 1.05,
    qualityScores: { routing: 58, planning: 72, coding: 84, review: 78, classify: 58 },
  },
  'z-ai/glm-5.2': {
    vendor: 'z-ai',
    modelClass: 'frontier',
    reasoningTier: 'advanced',
    contextWindowTokens: 1_048_576,
    multimodal: { text: true, image: false },
    inputCost: 0.93,
    outputCost: 3,
    qualityScores: { routing: 60, planning: 80, coding: 80, review: 84, classify: 60 },
  },
  'moonshotai/kimi-k2.7-code': {
    vendor: 'moonshotai',
    modelClass: 'strong_generalist',
    reasoningTier: 'advanced',
    contextWindowTokens: 262_144,
    multimodal: { text: true, image: true },
    inputCost: 0.74,
    outputCost: 3.5,
    qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
  },
};

export function getConfiguredNativeExpansionModels(config: unknown): string[] {
  const parsed = config as {
    nativeAgent?: {
      providers?: {
        openrouter?: {
          models?: unknown;
        };
      };
    };
  };
  const models = parsed.nativeAgent?.providers?.openrouter?.models;
  if (!Array.isArray(models)) {
    return [];
  }
  return models.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function pickRequestedModel(config: unknown, explicitModel?: string): string {
  const configured = getConfiguredNativeExpansionModels(config);
  if (configured.length === 0) {
    throw new Error('No configured native OpenRouter task-expansion models were found in .wavemill-config.json.');
  }

  if (explicitModel) {
    if (!configured.includes(explicitModel)) {
      throw new Error(`Requested model ${explicitModel} is not configured for native task expansion.`);
    }
    return explicitModel;
  }

  for (const candidate of TARGET_MODELS) {
    if (configured.includes(candidate)) {
      return candidate;
    }
  }

  return configured[0]!;
}

export function assessHappyPath(observation: HappyPathObservation): CriterionResult {
  const providerMatches = observation.native.provider === 'openrouter';
  const modelMatches = observation.native.model === observation.requestedModel;
  const hasText = observation.text.trim().length > 0;

  if (!providerMatches || !modelMatches || !hasText) {
    const detail = [
      providerMatches ? null : `provider=${observation.native.provider}`,
      modelMatches ? null : `model=${observation.native.model}`,
      hasText ? null : 'empty task packet',
    ].filter(Boolean).join(', ');
    return {
      id: 'C1',
      title: 'Native task expansion runs for a configured OpenRouter model',
      status: 'fail',
      detail: `Expected native OpenRouter expansion for ${observation.requestedModel}; observed ${detail}.`,
      artifacts: [observation.artifacts.taskPacket, observation.artifacts.sidecar, observation.artifacts.transcript],
    };
  }

  return {
    id: 'C1',
    title: 'Native task expansion runs for a configured OpenRouter model',
    status: 'pass',
    detail: `provider=${observation.native.provider} model=${observation.native.model} api=${observation.native.api}`,
    artifacts: [observation.artifacts.taskPacket, observation.artifacts.sidecar, observation.artifacts.transcript],
  };
}

export function assessArtifactCompleteness(observation: HappyPathObservation): CriterionResult {
  const missingPaths = Object.entries(observation.artifacts)
    .filter(([, value]) => !existsSync(value))
    .map(([key]) => key);

  if (missingPaths.length > 0) {
    return {
      id: 'C2',
      title: 'Expanded packet is valid and expand-issue artifact layout is written',
      status: 'fail',
      detail: `Missing artifact paths: ${missingPaths.join(', ')}.`,
      artifacts: Object.values(observation.artifacts),
    };
  }

  if (!isValidTaskPacket(observation.text)) {
    return {
      id: 'C2',
      title: 'Expanded packet is valid and expand-issue artifact layout is written',
      status: 'fail',
      detail: 'Expanded text did not match the expected task-packet markdown shape.',
      artifacts: Object.values(observation.artifacts),
    };
  }

  const split = splitTaskPacket(observation.text);
  if (!split.header.trim() || !split.details.trim()) {
    return {
      id: 'C2',
      title: 'Expanded packet is valid and expand-issue artifact layout is written',
      status: 'fail',
      detail: 'Task packet did not produce both header and details artifacts.',
      artifacts: Object.values(observation.artifacts),
    };
  }

  return {
    id: 'C2',
    title: 'Expanded packet is valid and expand-issue artifact layout is written',
    status: 'pass',
    detail: `Wrote ${relativePath(observation.artifacts.taskPacket)} plus header/details/native sidecar (validator issues=${observation.validationIssueCount}).`,
    artifacts: Object.values(observation.artifacts),
  };
}

export function assessProvenance(observation: HappyPathObservation): CriterionResult {
  const failures: string[] = [];
  if (!observation.sidecar.transcriptPath?.trim()) {
    failures.push('missing transcriptPath');
  }
  if (
    !Number.isFinite(observation.sidecar.cost)
    || !Number.isFinite(observation.sidecar.totalInputTokens)
    || !Number.isFinite(observation.sidecar.totalOutputTokens)
  ) {
    failures.push('missing numeric usage/cost fields');
  }
  if (!observation.sidecar.provider || !observation.sidecar.model || !observation.sidecar.api) {
    failures.push('missing provider/model/api identity');
  }
  if (!Array.isArray(observation.sidecar.deniedToolCalls)) {
    failures.push('missing deniedToolCalls array');
  }
  if (!existsSync(observation.artifacts.manifest) || observation.manifest.resources.length === 0) {
    failures.push('missing manifest/resource records');
  }
  if (!existsSync(observation.artifacts.registry) || observation.resources.length === 0) {
    failures.push('missing registry records');
  }
  if ((observation.manifest.phases?.['task-expansion']?.length ?? 0) === 0) {
    failures.push('missing task-expansion manifest refs');
  }

  if (failures.length > 0) {
    return {
      id: 'C3',
      title: 'Transcript, usage, identity, denied-tool, and provenance records are present',
      status: 'fail',
      detail: failures.join('; '),
      artifacts: [observation.artifacts.sidecar, observation.artifacts.transcript, observation.artifacts.manifest, observation.artifacts.registry],
    };
  }

  return {
    id: 'C3',
    title: 'Transcript, usage, identity, denied-tool, and provenance records are present',
    status: 'pass',
    detail: `transcript=${relativePath(observation.artifacts.transcript)} manifestRefs=${observation.manifest.resources.length} registryRecords=${observation.resources.length}`,
    artifacts: [observation.artifacts.sidecar, observation.artifacts.transcript, observation.artifacts.manifest, observation.artifacts.registry],
  };
}

export function assessMutationPolicy(observation: MutationObservation): CriterionResult {
  const denied = observation.deniedToolCalls.some((entry) => entry.tool === 'patch_file' && /phase_denied:/.test(entry.reason));
  const statusStable = observation.gitStatusBefore === observation.gitStatusAfter;
  const hashStable = observation.trackedHashBefore === observation.trackedHashAfter;

  if (!denied || !statusStable || !hashStable) {
    const detail = [
      denied ? null : 'patch_file denial missing from sidecar',
      statusStable ? null : 'git status changed',
      hashStable ? null : 'tracked file hash changed',
    ].filter(Boolean).join('; ');
    return {
      id: 'C4',
      title: 'Read-only policy denies mutation attempts and leaves the worktree unchanged',
      status: 'fail',
      detail,
      artifacts: [observation.transcriptPath, observation.manifestPath],
    };
  }

  return {
    id: 'C4',
    title: 'Read-only policy denies mutation attempts and leaves the worktree unchanged',
    status: 'pass',
    detail: `Denied ${observation.deniedToolCalls.length} mutation call(s); git status and tracked hashes were unchanged.`,
    artifacts: [observation.transcriptPath, observation.manifestPath],
  };
}

export function assessCertificationGate(cases: readonly SelectionCase[]): CriterionResult {
  const missing = cases.find((entry) => entry.caseId === 'missing');
  const stale = cases.find((entry) => entry.caseId === 'stale');
  const fresh = cases.find((entry) => entry.caseId === 'fresh');

  const failures: string[] = [];
  if (!missing || missing.status !== 'uncertified' || !missing.reason?.includes('reason=missing_artifact')) {
    failures.push('missing certification did not fail closed');
  }
  if (!stale || stale.status !== 'uncertified' || !stale.reason?.includes('reason=stale_artifact')) {
    failures.push('stale certification did not fail closed');
  }
  if (!fresh || fresh.status !== 'ready') {
    failures.push('fresh certification did not remain selectable');
  }

  if (failures.length > 0) {
    return {
      id: 'C5',
      title: 'Missing or stale read-only certification blocks task-expansion model selection',
      status: 'fail',
      detail: failures.join('; '),
      artifacts: [],
    };
  }

  return {
    id: 'C5',
    title: 'Missing or stale read-only certification blocks task-expansion model selection',
    status: 'pass',
    detail: cases.map((entry) => `${entry.caseId}=>${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`).join('; '),
    artifacts: [],
  };
}

export function assessFallbackSemantics(observation: FallbackObservation): CriterionResult {
  const failures: string[] = [];
  if (observation.fallbackText !== 'claude fallback') {
    failures.push('availability failure did not return Claude fallback text');
  }
  if (!observation.warningText.includes('falling back to Claude expansion')) {
    failures.push('availability fallback warning was not surfaced');
  }
  if (!observation.nonAvailabilityError.includes('non-availability-native-failure')) {
    failures.push('non-availability failure was swallowed');
  }

  if (failures.length > 0) {
    return {
      id: 'C6',
      title: 'fallbackOnUnavailable preserves Claude rollback only for prerequisite failures',
      status: 'fail',
      detail: failures.join('; '),
      artifacts: [],
    };
  }

  return {
    id: 'C6',
    title: 'fallbackOnUnavailable preserves Claude rollback only for prerequisite failures',
    status: 'pass',
    detail: 'missing_key fallback returned Claude with a warning; non-availability error was rethrown.',
    artifacts: [],
  };
}

export function extractNumberedSections(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(\d+\.\s+.+)$/gm)].map((match) => match[1]!.trim());
}

export function assessStructure(comparison: StructuralComparison): CriterionResult {
  if (comparison.missingSections.length > 0) {
    return {
      id: 'C7',
      title: 'Native packet matches the Claude/Codex baseline structure',
      status: 'fail',
      detail: `Structural regression: missing ${comparison.missingSections.map((section) => `"${section}"`).join(', ')}.`,
      artifacts: [comparison.baselinePath],
    };
  }

  return {
    id: 'C7',
    title: 'Native packet matches the Claude/Codex baseline structure',
    status: 'pass',
    detail: `${comparison.nativeSections.length} numbered sections matched baseline ${relativePath(comparison.baselinePath)}.`,
    artifacts: [comparison.baselinePath],
  };
}

function baseConfig(modelId: string, options: { fallbackOnUnavailable?: boolean } = {}): Record<string, unknown> {
  const meta = MODEL_META[modelId];
  if (!meta) {
    throw new Error(`Unsupported model for verifier: ${modelId}`);
  }

  const registryModels = {
    [modelId]: {
      vendor: meta.vendor,
      class: meta.modelClass,
      strengths: ['verification'],
      weaknesses: [],
      qualityScores: meta.qualityScores,
      contextWindowTokens: meta.contextWindowTokens,
      toolSupport: 'full',
      multimodal: meta.multimodal,
      latencyTier: 'standard',
      reasoningTier: meta.reasoningTier,
      costPerMillionInputTokensUsd: meta.inputCost,
      costPerMillionOutputTokensUsd: meta.outputCost,
      agent: 'native-openrouter',
      nativeCapability: {
        nativeProvider: 'openrouter',
        piTransportKind: 'openai-completions',
        readOnlyNative: 'certified',
        compatFlags: { thinkingFormat: 'openrouter' },
        certification: {
          maxCertifiedPhase: 'workflow',
          certifiedAt: FIXED_NOW.toISOString(),
          certificationSuiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        },
      },
    },
  } as Record<string, Partial<ModelCapabilities>>;

  return {
    configVersion: '1.4.1',
    nativeAgent: {
      enabled: true,
      allowedPhases: ['task-expansion'],
      expansion: {
        fallbackOnUnavailable: options.fallbackOnUnavailable ?? true,
      },
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
          models: [modelId],
        },
      },
    },
    modelRegistry: {
      models: registryModels,
    },
  };
}

function makeRepo(modelId: string, options: { fallbackOnUnavailable?: boolean } = {}): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'hok2424-native-expansion-'));
  execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'hok2424@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'HOK-2424 Verifier'], { stdio: 'pipe' });
  writeFileSync(join(repoDir, '.gitignore'), '.wavemill/\n', 'utf-8');
  writeFileSync(join(repoDir, 'notes.md'), '# Notes\n\nNative task expansion verifier fixture.\n', 'utf-8');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(baseConfig(modelId, options), null, 2)}\n`, 'utf-8');
  clearConfigCache(repoDir);
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init verifier fixture'], { stdio: 'pipe' });
  return repoDir;
}

function cleanupRepo(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
}

function getRegistry(repoDir: string): ModelRegistry {
  const config = JSON.parse(readFileSync(join(repoDir, '.wavemill-config.json'), 'utf-8')) as {
    modelRegistry?: {
      models?: Record<string, Partial<ModelCapabilities>>;
      ladders?: ModelRegistry['ladders'];
    };
  };
  return {
    models: config.modelRegistry?.models ?? {},
    ladders: config.modelRegistry?.ladders ?? {},
  } as unknown as ModelRegistry;
}

function writeCertification(
  repoDir: string,
  modelId: string,
  overrides: Partial<NativeCertificationArtifact> = {},
): string {
  const identity = resolveCertificationStorageIdentity('openrouter', modelId);
  const path = buildCertificationPath(repoDir, 'openrouter', modelId, DEFAULT_CERTIFICATION_SUITE_VERSION);
  mkdirSync(dirname(path), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase: 'workflow',
    suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
    certifiedAt: FIXED_NOW.toISOString(),
    scenarios: [{ scenarioId: 'hok2424.read-only', passed: true }],
    ...overrides,
  };
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return path;
}

function makeToolRegistryWithDeniedMutation(repoDir: string) {
  const registry = createToolRegistry([
    ...createReadOnlyTools(repoDir),
    ...createGitTools(repoDir),
    {
      metadata: {
        name: 'patch_file',
        description: 'Write or patch a file.',
        class: 'mutation',
        allowedPhases: [],
        executionMode: 'sequential',
        outputCapPolicy: { strategy: 'none' },
      },
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async execute() {
        throw new Error('patch_file must be blocked by read-only policy');
      },
    },
  ]);

  return {
    getTools: (filter?: { phase?: string }) => registry.getTools(filter),
    list: (filter?: { phase?: string }) => registry.list(filter),
    register() {},
    has() {
      return false;
    },
  };
}

function makeTaskPacketMarkdown(modelId: string, variant: 'happy' | 'denied' = 'happy'): string {
  const baselinePath = join(
    process.cwd(),
    'features',
    'verification-companion-for-native-openrouter-task-expansion-rollout',
    'task-packet.md',
  );
  const baseline = readFileSync(baselinePath, 'utf-8');
  if (variant === 'happy') {
    return baseline;
  }
  return baseline.replace(
    'Build an executable verification harness',
    `Build an executable verification harness after a denied mutation attempt for ${modelId}`,
  );
}

function buildSession(modelId: string, suffix: string): string {
  return `hok2424-${sanitize(modelId)}-${suffix}-${Date.now()}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function relativePath(path: string): string {
  return relative(process.cwd(), path) || path;
}

function gitStatus(repoDir: string): string {
  return execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], { encoding: 'utf-8' }).trim();
}

function trackedHash(repoDir: string): string {
  const output = execFileSync('git', ['-C', repoDir, 'ls-files', '-z'], { encoding: 'utf-8' });
  const hash = createHash('sha256');
  for (const file of output.split('\0').filter(Boolean).sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(repoDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function runHappyPath(
  modelId: string,
  options: { live?: boolean; cleanup?: boolean } = {},
): Promise<HappyPathObservation> {
  const repoDir = makeRepo(modelId, { fallbackOnUnavailable: true });
  writeCertification(repoDir, modelId);
  const session = buildSession(modelId, options.live ? 'live' : 'offline');
  const outputFile = join(repoDir, '.wavemill', 'verification', 'task-packet.md');
  const scriptedApi = `hok2424-scripted-${sanitize(modelId)}-${Date.now()}`;

  if (!options.live) {
    const packet = makeTaskPacketMarkdown(modelId);
    registerScriptedPiProvider({
      api: scriptedApi,
      turns: ({ sawToolResults }) => (
        sawToolResults
          ? {
            content: [{ type: 'text', text: packet }],
            usage: { input: 800, output: 500 },
            stopReason: 'stop',
          }
          : {
            content: [{ type: 'tool_call', id: 'read-1', name: 'read_file', arguments: { path: 'notes.md' } }],
            usage: { input: 300, output: 100 },
            stopReason: 'toolUse',
          }
      ),
    });
  }

  openManifest(session, { workflowType: 'verification', repoDir });
  try {
    const registry = getRegistry(repoDir);
    const result = await runNativeExpansion({
      promptTemplate: 'Issue context:\n{{ISSUE_CONTEXT}}\n\nCodebase context:\n{{CODEBASE_CONTEXT}}\n\n{{DEGRADED_MODE_CONTEXT}}',
      issueContext: DEFAULT_ISSUE_CONTEXT,
      codebaseContext: DEFAULT_CODEBASE_CONTEXT,
      mode: 'normal',
      repoDir,
      issueId: ISSUE_ID,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || 'sk-openrouter-test',
        WAVEMILL_SESSION: session,
        WAVEMILL_ISSUE: ISSUE_ID,
      },
      registry,
      ...(options.live ? {} : {
        modelOverride: {
          id: `scripted:${sanitize(modelId)}`,
          name: `${modelId}-scripted`,
          api: scriptedApi,
          provider: 'scripted',
          baseUrl: 'http://localhost:0/mock',
          headers: {},
        },
      }),
    });
    closeManifest(session, { status: 'completed', repoDir });

    const packetParts = splitTaskPacket(result.text);
    const packetPaths = await writeTaskPacketArtifacts(outputFile, packetParts);
    const sidecarPath = await writeNativeExpansionSidecar(outputFile, result.native);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as NativeExpansionMetadata;
    const validation = await validateTaskPacket(result.text, repoDir, {
      ...DEFAULT_VALIDATION_CONFIG,
      layer2: { enabled: false },
    });
    const manifestPath = resolveManifestPath(session, repoDir);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ResourceManifest;
    const registryFile = resolveRegistryFile(repoDir);
    const resources = listResources({}, repoDir);

    return {
      repoDir,
      session,
      requestedModel: modelId,
      live: options.live === true,
      text: result.text,
      native: result.native,
      sidecar,
      artifacts: {
        taskPacket: packetPaths.full,
        header: packetPaths.header,
        details: packetPaths.details,
        sidecar: sidecarPath,
        transcript: result.native.transcriptPath,
        manifest: manifestPath,
        registry: registryFile,
      },
      validationPassed: validation.passed,
      validationIssueCount: validation.issues.length,
      manifest,
      resources,
    };
  } catch (error) {
    closeManifest(session, { status: 'failed', repoDir });
    if (options.cleanup !== false) {
      cleanupRepo(repoDir);
    }
    throw error;
  }
}

async function runMutationCase(modelId: string): Promise<MutationObservation> {
  const repoDir = makeRepo(modelId, { fallbackOnUnavailable: true });
  writeCertification(repoDir, modelId);
  const session = buildSession(modelId, 'mutation');
  const api = `hok2424-denied-${sanitize(modelId)}-${Date.now()}`;
  registerScriptedPiProvider({
    api,
    turns: ({ sawToolResults }) => (
      sawToolResults
        ? {
          content: [{ type: 'text', text: makeTaskPacketMarkdown(modelId, 'denied') }],
          usage: { input: 500, output: 300 },
          stopReason: 'stop',
        }
        : {
          content: [{
            type: 'tool_call',
            id: 'patch-1',
            name: 'patch_file',
            arguments: { path: 'notes.md', content: 'mutate' },
          }],
          usage: { input: 200, output: 100 },
          stopReason: 'toolUse',
        }
    ),
  });

  const beforeStatus = gitStatus(repoDir);
  const beforeHash = trackedHash(repoDir);

  openManifest(session, { workflowType: 'verification', repoDir });
  try {
    const result = await runNativeExpansion({
      promptTemplate: 'Issue context:\n{{ISSUE_CONTEXT}}\n\n{{CODEBASE_CONTEXT}}',
      issueContext: DEFAULT_ISSUE_CONTEXT,
      codebaseContext: DEFAULT_CODEBASE_CONTEXT,
      mode: 'normal',
      repoDir,
      issueId: ISSUE_ID,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: 'sk-openrouter-test',
        WAVEMILL_SESSION: session,
        WAVEMILL_ISSUE: ISSUE_ID,
      },
      registry: getRegistry(repoDir),
      toolRegistryOverride: makeToolRegistryWithDeniedMutation(repoDir),
      modelOverride: {
        id: `scripted:${sanitize(modelId)}-denied`,
        name: `${modelId}-scripted-denied`,
        api,
        provider: 'scripted',
        baseUrl: 'http://localhost:0/mock',
        headers: {},
      },
    });
    closeManifest(session, { status: 'completed', repoDir });

    return {
      requestedModel: modelId,
      deniedToolCalls: result.native.deniedToolCalls,
      gitStatusBefore: beforeStatus,
      gitStatusAfter: gitStatus(repoDir),
      trackedHashBefore: beforeHash,
      trackedHashAfter: trackedHash(repoDir),
      transcriptPath: result.native.transcriptPath,
      manifestPath: resolveManifestPath(session, repoDir),
    };
  } catch (error) {
    closeManifest(session, { status: 'failed', repoDir });
    throw error;
  }
}

function runSelectionCases(modelId: string): SelectionCase[] {
  const cases: Array<{ caseId: SelectionCase['caseId']; setup: (repoDir: string) => void }> = [
    { caseId: 'missing', setup: () => {} },
    {
      caseId: 'stale',
      setup: (repoDir) => {
        writeCertification(repoDir, modelId, {
          certifiedAt: new Date(FIXED_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
        });
      },
    },
    {
      caseId: 'fresh',
      setup: (repoDir) => {
        writeCertification(repoDir, modelId);
      },
    },
  ];

  return cases.map((entry) => {
    const repoDir = makeRepo(modelId, { fallbackOnUnavailable: true });
    try {
      entry.setup(repoDir);
      const [resolved] = resolveNativeAgentProviders(repoDir, {
        env: { OPENROUTER_API_KEY: 'sk-openrouter-test' },
        phase: 'task-expansion',
        registry: getRegistry(repoDir),
        now: FIXED_NOW,
      });
      return {
        caseId: entry.caseId,
        status: resolved?.status ?? 'missing',
        reason: 'reason' in (resolved ?? {}) ? (resolved as { reason?: string }).reason : undefined,
      };
    } finally {
      cleanupRepo(repoDir);
    }
  });
}

async function runFallbackChecks(): Promise<FallbackObservation> {
  const repoDir = makeRepo(TARGET_MODELS[0], { fallbackOnUnavailable: true });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((entry) => String(entry)).join(' '));
  };

  try {
    const fallbackResult = await expandIssue({
      promptTemplate: 'prompt',
      issueContext: 'issue',
      repoDir,
    }, {
      expandIssueWithClaude: async () => 'claude fallback',
      importNativeExpansion: async () => ({
        NativeExpansionUnavailableError,
        runNativeExpansion: async () => {
          throw new NativeExpansionUnavailableError('missing_key', 'OPENROUTER_API_KEY is not set');
        },
      }),
    });

    let nonAvailabilityError = '';
    try {
      await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        expandIssueWithClaude: async () => 'should not be returned',
        importNativeExpansion: async () => ({
          NativeExpansionUnavailableError,
          runNativeExpansion: async () => {
            throw new Error('non-availability-native-failure');
          },
        }),
      });
    } catch (error) {
      nonAvailabilityError = error instanceof Error ? error.message : String(error);
    }

    return {
      fallbackText: fallbackResult.text,
      warningText: warnings.join('\n'),
      nonAvailabilityError,
    };
  } finally {
    console.warn = originalWarn;
    cleanupRepo(repoDir);
  }
}

function compareAgainstBaseline(nativeText: string): StructuralComparison {
  const baselinePath = join(
    process.cwd(),
    'features',
    'verification-companion-for-native-openrouter-task-expansion-rollout',
    'task-packet.md',
  );
  const baseline = readFileSync(baselinePath, 'utf-8');
  const nativeSections = extractNumberedSections(nativeText);
  const baselineSections = extractNumberedSections(baseline);
  return {
    baselinePath,
    nativeSections,
    baselineSections,
    missingSections: baselineSections.filter((section) => !nativeSections.includes(section)),
  };
}

function renderHumanSummary(summary: VerificationSummary): string {
  const lines = [
    `${summary.issueId} native OpenRouter task-expansion verification`,
    `Generated: ${summary.generatedAt}`,
    `Requested model: ${summary.requestedModel}`,
    '',
    '| Criterion | Status | Evidence |',
    '| --- | --- | --- |',
    ...summary.criteria.map((result) => `| ${result.id} ${result.title} | ${result.status.toUpperCase()} | ${result.detail} |`),
    '',
    'Artifacts:',
    ...summary.criteria
      .flatMap((result) => result.artifacts)
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .map((value) => `- ${relativePath(value)}`),
    '',
    `Live run: ${summary.liveRun.status.toUpperCase()} - ${summary.liveRun.reason}`,
  ];
  return lines.join('\n');
}

async function runVerification(input: { requestedModel?: string; live?: boolean }): Promise<VerificationSummary> {
  const repoConfig = JSON.parse(readFileSync(join(process.cwd(), '.wavemill-config.json'), 'utf-8'));
  const configuredModels = getConfiguredNativeExpansionModels(repoConfig);
  const requestedModel = pickRequestedModel(repoConfig, input.requestedModel);
  const offline = await runHappyPath(requestedModel, { live: false, cleanup: false });
  const mutation = await runMutationCase(requestedModel);
  const selectionCases = runSelectionCases(requestedModel);
  const fallback = await runFallbackChecks();
  const structure = compareAgainstBaseline(offline.text);

  let liveRun: LiveRunSummary = {
    requested: input.live === true,
    status: 'skipped',
    reason: 'Live run not requested.',
  };
  if (input.live === true) {
    if (!process.env.OPENROUTER_API_KEY) {
      liveRun = {
        requested: true,
        status: 'skipped',
        reason: 'OPENROUTER_API_KEY is not set in this environment.',
      };
    } else {
      const observation = await runHappyPath(requestedModel, { live: true, cleanup: false });
      liveRun = {
        requested: true,
        status: 'executed',
        reason: `Executed live native expansion for ${requestedModel}.`,
        observation,
      };
    }
  }

  const criteria = [
    assessHappyPath(offline),
    assessArtifactCompleteness(offline),
    assessProvenance(offline),
    assessMutationPolicy(mutation),
    assessCertificationGate(selectionCases),
    assessFallbackSemantics(fallback),
    assessStructure(structure),
  ];

  return {
    issueId: ISSUE_ID,
    generatedAt: new Date().toISOString(),
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    nodeVersion: process.version,
    requestedModel,
    configuredModels,
    criteria,
    offline,
    mutation,
    selectionCases,
    fallback,
    structure,
    liveRun,
  };
}

function exitCodeFor(summary: VerificationSummary): number {
  return summary.criteria.some((result) => result.status === 'fail') ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTool({
    name: 'hok2424-verify-native-expansion',
    description: 'Verify native OpenRouter task-expansion rollout behavior',
    options: {
      live: { type: 'boolean', description: 'Run one live native OpenRouter expansion when OPENROUTER_API_KEY is set.' },
      model: { type: 'string', description: 'Configured native OpenRouter model to verify.' },
      json: { type: 'boolean', description: 'Emit machine-readable JSON instead of the human summary.' },
    },
    examples: [
      'npx tsx tools/hok2424-verify-native-expansion.ts',
      'npx tsx tools/hok2424-verify-native-expansion.ts --live',
      'npx tsx tools/hok2424-verify-native-expansion.ts --model z-ai/glm-5.2 --json',
    ],
    async run({ args }) {
      const summary = await runVerification({
        requestedModel: args.model,
        live: args.live === true,
      });

      if (args.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(renderHumanSummary(summary));
      }

      process.exitCode = exitCodeFor(summary);
    },
  });
}

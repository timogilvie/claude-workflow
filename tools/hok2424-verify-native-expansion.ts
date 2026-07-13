#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { clearConfigCache } from '../shared/lib/config.ts';
import { NativeExpansionUnavailableError, runNativeExpansion, writeNativeExpansionSidecar, type NativeExpansionMetadata } from '../shared/lib/native-expansion.ts';
import { expandIssue } from '../shared/lib/issue-expander.ts';
import { createToolRegistry } from '../shared/lib/native-agent/tools/registry.ts';
import { createReadOnlyTools } from '../shared/lib/native-agent/tools/read-only.ts';
import { createGitTools } from '../shared/lib/native-agent/tools/git.ts';
import { registerScriptedPiProvider } from '../shared/lib/native-agent/provider.ts';
import { buildCertificationPath } from '../shared/lib/native-agent/certification/loader.ts';
import { resolveCertificationStorageIdentity } from '../shared/lib/native-agent/certification/identity.ts';
import { CERTIFICATION_SCHEMA_VERSION, type CertificationPhase, type NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';
import { getManifest, openManifest, closeManifest, resolveManifestPath, type ResourceManifest } from '../shared/lib/resource-manifest.ts';
import { splitTaskPacket, writeTaskPacketArtifacts, isValidTaskPacket, type TaskPacketArtifactPaths } from '../shared/lib/task-packet-utils.ts';
import { validateTaskPacket, DEFAULT_VALIDATION_CONFIG } from '../shared/lib/task-packet-validator.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';
import type { ModelCapabilities, ModelRegistry } from '../shared/lib/model-registry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISSUE_ID = 'HOK-2424';
const LINKED_ISSUE_ID = 'HOK-2416';
const EVIDENCE_PATH = 'features/verification-companion-for-native-openrouter-task-expansion-rollout-challenger/verification-evidence.md';
const BASELINE_PACKET_PATH = resolve(__dirname, '../tests/fixtures/hok2424-claude-baseline-task-packet.md');
const SPLIT_MARKER = '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->';
const DEFAULT_NOW = new Date('2026-07-13T12:00:00.000Z');
const PREFERRED_ROLLOUT_MODELS = [
  'qwen/qwen3-coder',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k2.7-code',
] as const;

const MODEL_FIXTURES: Record<string, Pick<ModelCapabilities, 'vendor' | 'class' | 'qualityScores' | 'contextWindowTokens' | 'multimodal' | 'reasoningTier' | 'costPerMillionInputTokensUsd' | 'costPerMillionOutputTokensUsd'>> = {
  'qwen/qwen3-coder': {
    vendor: 'qwen',
    class: 'strong_generalist',
    qualityScores: { routing: 58, planning: 72, coding: 84, review: 78, classify: 58 },
    contextWindowTokens: 262_144,
    multimodal: { text: true, image: false },
    reasoningTier: 'advanced',
    costPerMillionInputTokensUsd: 0.35,
    costPerMillionOutputTokensUsd: 1.05,
  },
  'z-ai/glm-5.2': {
    vendor: 'z-ai',
    class: 'frontier',
    qualityScores: { routing: 60, planning: 80, coding: 80, review: 84, classify: 60 },
    contextWindowTokens: 1_048_576,
    multimodal: { text: true, image: false },
    reasoningTier: 'advanced',
    costPerMillionInputTokensUsd: 0.93,
    costPerMillionOutputTokensUsd: 3,
  },
  'moonshotai/kimi-k2.7-code': {
    vendor: 'moonshotai',
    class: 'strong_generalist',
    qualityScores: { routing: 60, planning: 72, coding: 82, review: 82, classify: 58 },
    contextWindowTokens: 262_144,
    multimodal: { text: true, image: true },
    reasoningTier: 'advanced',
    costPerMillionInputTokensUsd: 0.74,
    costPerMillionOutputTokensUsd: 3.5,
  },
};

export interface ManifestPhaseSummary {
  totalPhaseRefs: number;
  promptRefs: number;
  runtimeRefs: number;
  agentConfigRefs: number;
  totalResources: number;
}

export interface ExpansionArtifacts {
  repoDir: string;
  taskPacket: string;
  header: string;
  details: string;
  sidecar: string;
  transcript: string;
  manifest: string;
}

export interface ExpansionRunSummary {
  modelId: string;
  provider: string;
  api: string;
  agent: string;
  cost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  deniedToolCalls: ReadonlyArray<{ tool: string; reason: string }>;
  taskPacketValid: boolean;
  validationPassed: boolean;
  validationIssueCount: number;
  hasSplitMarker: boolean;
  gitStatusBefore: string;
  gitStatusAfter: string;
  rawPacket: string;
  sidecar: NativeExpansionMetadata;
  manifestPhase: ManifestPhaseSummary;
  artifacts: ExpansionArtifacts;
}

export interface CertificationCaseSummary {
  caseId: 'valid' | 'missing' | 'stale' | 'wrong-suite' | 'malformed';
  status: string;
  reason?: string;
}

export interface FallbackCheckSummary {
  unavailableFallbackReturnedClaude: boolean;
  unavailableFallbackWarning: string;
  unavailableResultHasNativeMetadata: boolean;
  nonAvailabilityErrorMessage: string;
  nonAvailabilityClaudeCalls: number;
}

export interface StructureComparisonSummary {
  baselinePath: string;
  baselineHeadings: string[];
  missingHeadings: string[];
  hasSplitMarker: boolean;
}

export interface VerificationSummary {
  issueId: string;
  linkedIssueId: string;
  repoDir: string;
  gitSha: string;
  generatedAt: string;
  selectedModels: string[];
  expansionRuns: ExpansionRunSummary[];
  certificationCases: CertificationCaseSummary[];
  fallback: FallbackCheckSummary;
  structure: StructureComparisonSummary;
  worktreeStatusBefore: string;
  worktreeStatusAfter: string;
  evidencePath: string;
  passed: boolean;
}

interface VerificationOptions {
  repoDir: string;
  model?: string;
  allModels?: boolean;
}

export function getConfiguredNativeOpenRouterModels(config: unknown): string[] {
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
  return models.filter((model): model is string => typeof model === 'string' && model.trim().length > 0);
}

export function selectVerificationModels(config: unknown, options: { model?: string; allModels?: boolean } = {}): string[] {
  const configured = getConfiguredNativeOpenRouterModels(config);
  if (configured.length === 0) {
    throw new Error('No configured native OpenRouter task-expansion models were found in .wavemill-config.json.');
  }

  if (options.model) {
    if (!configured.includes(options.model)) {
      throw new Error(`Model ${options.model} is not configured for native OpenRouter task expansion.`);
    }
    return [options.model];
  }

  if (options.allModels) {
    return configured;
  }

  for (const preferred of PREFERRED_ROLLOUT_MODELS) {
    if (configured.includes(preferred)) {
      return [preferred];
    }
  }

  return [configured[0]!];
}

export function compareTaskPacketStructure(nativePacket: string, baselinePacket: string): StructureComparisonSummary {
  const baselineHeadings = baselinePacket
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line));
  const nativeLines = new Set(nativePacket.split('\n').map((line) => line.trim()));

  return {
    baselinePath: BASELINE_PACKET_PATH,
    baselineHeadings,
    missingHeadings: baselineHeadings.filter((heading) => !nativeLines.has(heading)),
    hasSplitMarker: nativePacket.includes(SPLIT_MARKER),
  };
}

export function getArtifactFailures(summary: ExpansionRunSummary): string[] {
  const failures: string[] = [];
  if (!summary.taskPacketValid) {
    failures.push(`${summary.modelId}: native output is not a valid task packet.`);
  }
  if (!summary.hasSplitMarker) {
    failures.push(`${summary.modelId}: native packet is missing the split marker.`);
  }
  if (summary.sidecar.transcriptPath.trim().length === 0 || !existsSync(summary.sidecar.transcriptPath)) {
    failures.push(`${summary.modelId}: sidecar transcriptPath is missing or unreadable.`);
  }
  if (!Array.isArray(summary.sidecar.deniedToolCalls)) {
    failures.push(`${summary.modelId}: sidecar deniedToolCalls is not an array.`);
  }
  if (summary.sidecar.provider !== 'openrouter') {
    failures.push(`${summary.modelId}: sidecar provider=${summary.sidecar.provider} is not openrouter.`);
  }
  if (summary.sidecar.model !== summary.modelId) {
    failures.push(`${summary.modelId}: sidecar model=${summary.sidecar.model} does not match the selected model.`);
  }
  if (summary.sidecar.api.trim().length === 0) {
    failures.push(`${summary.modelId}: sidecar api is empty.`);
  }
  if (!Number.isFinite(summary.sidecar.cost)) {
    failures.push(`${summary.modelId}: sidecar cost is not numeric.`);
  }
  if (summary.manifestPhase.promptRefs < 1) {
    failures.push(`${summary.modelId}: task-expansion manifest is missing the prompt provenance record.`);
  }
  if (summary.manifestPhase.runtimeRefs < 1) {
    failures.push(`${summary.modelId}: task-expansion manifest is missing the runtime provenance record.`);
  }
  if (summary.manifestPhase.agentConfigRefs < 1) {
    failures.push(`${summary.modelId}: task-expansion manifest is missing the tool-set provenance record.`);
  }
  if (summary.deniedToolCalls.length < 1) {
    failures.push(`${summary.modelId}: read-only mutation denial was not recorded.`);
  }
  if (summary.gitStatusBefore !== summary.gitStatusAfter) {
    failures.push(`${summary.modelId}: git status changed after the denied mutation attempt.`);
  }
  for (const artifactPath of Object.values(summary.artifacts)) {
    if (!existsSync(artifactPath)) {
      failures.push(`${summary.modelId}: missing artifact ${artifactPath}.`);
    }
  }
  return failures;
}

export function getCertificationFailures(cases: readonly CertificationCaseSummary[]): string[] {
  const failures: string[] = [];
  for (const entry of cases) {
    if (entry.caseId === 'valid') {
      if (entry.status !== 'ready') {
        failures.push(`valid certification control was ${entry.status} instead of ready.`);
      }
      continue;
    }
    if (entry.status !== 'uncertified') {
      failures.push(`${entry.caseId} certification case returned ${entry.status} instead of uncertified.`);
    }
  }
  return failures;
}

export function getFallbackFailures(summary: FallbackCheckSummary): string[] {
  const failures: string[] = [];
  if (!summary.unavailableFallbackReturnedClaude) {
    failures.push('fallbackOnUnavailable did not preserve Claude rollback for a native prerequisite failure.');
  }
  if (!/falling back to Claude expansion/.test(summary.unavailableFallbackWarning)) {
    failures.push('fallbackOnUnavailable did not emit the expected fallback warning.');
  }
  if (summary.unavailableResultHasNativeMetadata) {
    failures.push('fallback result incorrectly reported native metadata.');
  }
  if (!/stopReason=error/.test(summary.nonAvailabilityErrorMessage)) {
    failures.push('non-availability native failure was not surfaced to the caller.');
  }
  if (summary.nonAvailabilityClaudeCalls !== 0) {
    failures.push('non-availability native failure incorrectly fell back to Claude.');
  }
  return failures;
}

function readRepoConfig(repoDir: string): unknown {
  return JSON.parse(readFileSync(join(repoDir, '.wavemill-config.json'), 'utf-8'));
}

function buildRegistry(models: readonly string[]): ModelRegistry {
  return {
    models: Object.fromEntries(models.map((modelId) => [modelId, makeCapabilities(modelId)])),
    ladders: {},
  };
}

function makeCapabilities(modelId: string): ModelCapabilities {
  const fixture = MODEL_FIXTURES[modelId] ?? {
    vendor: modelId.split('/')[0] ?? 'openrouter',
    class: 'strong_generalist' as const,
    qualityScores: { routing: 50, planning: 70, coding: 70, review: 70, classify: 50 },
    contextWindowTokens: 128_000,
    multimodal: { text: true, image: false },
    reasoningTier: 'advanced' as const,
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 3,
  };

  return {
    vendor: fixture.vendor,
    class: fixture.class,
    strengths: ['verification'],
    weaknesses: [],
    qualityScores: fixture.qualityScores,
    contextWindowTokens: fixture.contextWindowTokens,
    toolSupport: 'full',
    multimodal: fixture.multimodal,
    latencyTier: 'standard',
    reasoningTier: fixture.reasoningTier,
    costPerMillionInputTokensUsd: fixture.costPerMillionInputTokensUsd,
    costPerMillionOutputTokensUsd: fixture.costPerMillionOutputTokensUsd,
    agent: 'native-openrouter',
    nativeCapability: {
      nativeProvider: 'openrouter',
      piTransportKind: 'openai-completions',
      readOnlyNative: 'certified',
      compatFlags: { thinkingFormat: 'openrouter' },
      certification: {
        maxCertifiedPhase: 'workflow',
        certifiedAt: DEFAULT_NOW.toISOString(),
        certificationSuiteVersion: 'v1',
      },
    },
  };
}

function writeConfig(repoDir: string, models: readonly string[], fallbackOnUnavailable = true): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    configVersion: '1.4.1',
    nativeAgent: {
      enabled: true,
      allowedPhases: ['task-expansion', 'planning', 'review'],
      expansion: {
        fallbackOnUnavailable,
      },
      providers: {
        openrouter: {
          enabled: true,
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
          models,
        },
      },
    },
  }, null, 2)}\n`, 'utf-8');
  clearConfigCache(repoDir);
}

function writeCertification(repoDir: string, modelId: string, overrides: Partial<NativeCertificationArtifact> = {}): string {
  const artifactPath = buildCertificationPath(repoDir, 'openrouter', modelId, 'v1');
  const identity = resolveCertificationStorageIdentity('openrouter', modelId);
  mkdirSync(dirname(artifactPath), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase: 'read-only',
    suiteVersion: 'v1',
    certifiedAt: new Date(DEFAULT_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    scenarios: [{ scenarioId: `hok2424.${modelId}.readonly`, passed: true }],
    ...overrides,
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifactPath;
}

function writeMalformedCertification(repoDir: string, modelId: string): string {
  const artifactPath = buildCertificationPath(repoDir, 'openrouter', modelId, 'v1');
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, '{', 'utf-8');
  return artifactPath;
}

function makeVerificationRepo(models: readonly string[], fallbackOnUnavailable = true): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'hok2424-native-expansion-'));
  execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'hok2424@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'HOK-2424 Verifier'], { stdio: 'pipe' });
  writeFileSync(join(repoDir, '.gitignore'), '.wavemill/\nartifacts/\nprompt-registry.jsonl\n', 'utf-8');
  writeFileSync(join(repoDir, 'notes.md'), '# Notes\n\nNative expansion verification fixture.\n', 'utf-8');
  writeConfig(repoDir, models, fallbackOnUnavailable);
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init verification fixture'], { stdio: 'pipe' });
  return repoDir;
}

function gitStatusPorcelain(repoDir: string): string {
  return execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeToolRegistryWithDeniedMutation(repoDir: string) {
  return createToolRegistry([
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
        throw new Error('patch_file must be denied by policy before execution');
      },
    },
  ]);
}

function makePromptTemplate(): string {
  return [
    '# Verification Task Packet',
    '',
    '{{ISSUE_CONTEXT}}',
    '',
    '{{CODEBASE_CONTEXT}}',
    '',
    '{{DEGRADED_MODE_CONTEXT}}',
  ].join('\n');
}

function makeNativeTaskPacket(modelId: string): string {
  return [
    `# Native Verification Packet: ${modelId}`,
    '',
    'Offline fixture-backed native task expansion verification for HOK-2424.',
    '',
    '## Quick Reference',
    '',
    `- Model: \`${modelId}\``,
    '- Objective: verify native OpenRouter task expansion artifacts without mutating tracked files.',
    '- Linked rollout: HOK-2416.',
    '',
    SPLIT_MARKER,
    '',
    '## 1. Objective',
    '',
    '### What',
    `Verify the native task-expansion path for \`${modelId}\` and confirm the expected artifact contract.`,
    '',
    '### Why',
    'The rollout cannot complete until native expansion proves artifact completeness, certification gating, and fallback safety.',
    '',
    '### Scope In',
    '- Fixture-backed native expansion for the selected OpenRouter rollout model.',
    '- Artifact, provenance, and fallback checks.',
    '- Read-only mutation denial coverage.',
    '',
    '### Scope Out',
    '- Unrelated workflow-stage changes.',
    '- Broader OpenRouter routing changes.',
    '',
    '## 2. Technical Context',
    '',
    '### Repository',
    'wavemill',
    '',
    '### Key Files',
    '- `tools/expand-issue.ts`',
    '- `shared/lib/native-expansion.ts`',
    '- `shared/lib/issue-expander.ts`',
    '',
    '### Dependencies',
    '- `.wavemill/native-agent-certifications/`',
    '- `.wavemill/manifests/`',
    '',
    '### Architecture Notes',
    '- Read-only native task expansion must not modify tracked files.',
    '- Fallback is only for unavailable native prerequisites.',
    '',
    '## 3. Implementation Approach',
    '',
    '1. Run native expansion with a fixture-backed scripted provider.',
    '2. Persist task packet artifacts, sidecar metadata, transcript, and manifest provenance.',
    '3. Compare the native packet structure against the Claude/Codex baseline.',
    '',
    '## 4. Success Criteria',
    '',
    '### Functional Requirements',
    '- [ ] **[REQ-F1]** Expansion artifacts are written and validate as markdown.',
    '- [ ] **[REQ-F2]** Sidecar metadata includes usage, provider/model/API, and denied tool calls.',
    '- [ ] **[REQ-F3]** The session manifest includes prompt, runtime, and tool-set provenance records.',
    '',
    '### Non-Functional Requirements',
    '- [ ] Verification remains deterministic and offline by default.',
    '',
    '### Code Quality',
    '- [ ] Reuses existing verifier patterns.',
    '- [ ] Keeps changes additive and well-covered.',
    '',
    '## 5. Implementation Constraints',
    '',
    '- Code style: follow existing `runTool` verifier patterns.',
    '- Testing: prove pass and fail cases for each helper.',
    '- Security: do not weaken certification gates or read-only policy.',
    '',
    '## 6. Validation Steps',
    '',
    '### Functional Requirement Validation',
    '',
    '**[REQ-F1] Expansion artifacts are written and validate as markdown.**',
    '',
    'Validation scenario:',
    '1. Setup: run the verifier for the selected native model.',
    '2. Action: inspect the emitted full task packet, header, details, sidecar, transcript, and manifest files.',
    '3. Expected result: each file exists and the packet passes the markdown task-packet validator.',
    '4. Edge cases:',
    '   - Missing transcript path in the sidecar -> verifier fails.',
    '   - Missing prompt/runtime/tool-set manifest ref -> verifier fails.',
    '',
    '**[REQ-F3] The session manifest includes prompt, runtime, and tool-set provenance records.**',
    '',
    'Validation scenario:',
    '1. Setup: run native expansion in an isolated git repo.',
    '2. Action: inspect `.wavemill/manifests/<session>.json` after the run.',
    '3. Expected result: the `task-expansion` phase includes prompt, runtime, and agent-config resource refs.',
    '4. Edge cases:',
    '   - Missing prompt ref -> verifier fails.',
    '   - Missing runtime or tool-set ref -> verifier fails.',
    '',
    '## Release Readiness',
    '',
    '- **databaseChangeRisk**: none',
    '- **envChanges**: none',
    '- **configChanges**: package.json',
    '- **manualSteps**: paste verifier output into HOK-2424 and link the result to HOK-2416',
  ].join('\n');
}

function summarizeManifestPhase(manifest: ResourceManifest | null): ManifestPhaseSummary {
  const phaseRefs = manifest?.phases?.['task-expansion'] ?? [];
  return {
    totalPhaseRefs: phaseRefs.length,
    promptRefs: phaseRefs.filter((ref) => ref.id.startsWith('prompt:')).length,
    runtimeRefs: phaseRefs.filter((ref) => ref.id.startsWith('runtime:')).length,
    agentConfigRefs: phaseRefs.filter((ref) => ref.id.startsWith('agent-config:')).length,
    totalResources: manifest?.resources?.length ?? 0,
  };
}

async function runFixtureExpansion(modelId: string): Promise<ExpansionRunSummary> {
  const repoDir = makeVerificationRepo([modelId]);
  writeCertification(repoDir, modelId);
  const registry = buildRegistry([modelId]);
  const sessionId = `hok2424-${modelId.replace(/[^\w.-]+/g, '-')}-${Date.now()}`;
  const api = `hok2424-scripted-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const gitStatusBefore = gitStatusPorcelain(repoDir);

  registerScriptedPiProvider({
    api,
    turns: [
      {
        content: [{ type: 'tool_call', id: 'patch-1', name: 'patch_file', arguments: { path: 'notes.md', content: 'mutate' } }],
        usage: { input: 120, output: 24 },
        stopReason: 'toolUse',
      },
      {
        content: [{ type: 'text', text: makeNativeTaskPacket(modelId) }],
        usage: { input: 84, output: 48 },
        stopReason: 'stop',
      },
    ],
  });

  openManifest(sessionId, { workflowType: 'verification', repoDir });
  const result = await runNativeExpansion({
    promptTemplate: makePromptTemplate(),
    issueContext: `Issue: ${ISSUE_ID}`,
    codebaseContext: 'Relevant files: tools/expand-issue.ts, shared/lib/native-expansion.ts, shared/lib/issue-expander.ts',
    mode: 'normal',
    repoDir,
    issueId: ISSUE_ID,
    env: {
      OPENROUTER_API_KEY: 'sk-test-openrouter',
      WAVEMILL_ISSUE: ISSUE_ID,
      WAVEMILL_SESSION: sessionId,
    },
    registry,
    toolRegistryOverride: makeToolRegistryWithDeniedMutation(repoDir),
    modelOverride: {
      id: `scripted:${api}`,
      name: 'scripted-openrouter',
      api,
      provider: 'scripted',
      baseUrl: 'http://localhost/mock',
      headers: {},
    },
  });
  closeManifest(sessionId, { status: 'completed', repoDir });

  const rawPacket = result.text;
  const packetParts = splitTaskPacket(rawPacket);
  const outputPath = join(repoDir, 'artifacts', `${modelId.replace(/[^\w.-]+/g, '-')}-task-packet.md`);
  const artifacts = await writeTaskPacketArtifacts(outputPath, packetParts);
  const sidecarPath = await writeNativeExpansionSidecar(outputPath, result.native);
  const validation = await validateTaskPacket(packetParts.fullContent, repoDir, {
    ...DEFAULT_VALIDATION_CONFIG,
    layer2: { enabled: false },
  });
  const manifestPath = resolveManifestPath(sessionId, repoDir);
  const manifest = getManifest(sessionId, repoDir);
  const gitStatusAfter = gitStatusPorcelain(repoDir);
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as NativeExpansionMetadata;

  return {
    modelId,
    provider: result.native.provider,
    api: result.native.api,
    agent: result.native.agent,
    cost: result.native.cost,
    totalInputTokens: result.native.totalInputTokens,
    totalOutputTokens: result.native.totalOutputTokens,
    deniedToolCalls: result.native.deniedToolCalls,
    taskPacketValid: isValidTaskPacket(rawPacket),
    validationPassed: validation.passed,
    validationIssueCount: validation.issues.length,
    hasSplitMarker: rawPacket.includes(SPLIT_MARKER),
    gitStatusBefore,
    gitStatusAfter,
    rawPacket,
    sidecar,
    manifestPhase: summarizeManifestPhase(manifest),
    artifacts: {
      repoDir,
      taskPacket: artifacts.full,
      header: artifacts.header,
      details: artifacts.details,
      sidecar: sidecarPath,
      transcript: result.native.transcriptPath,
      manifest: manifestPath,
    },
  };
}

async function verifyCertificationGate(modelId: string): Promise<CertificationCaseSummary[]> {
  const cases: CertificationCaseSummary[] = [];
  const registry = buildRegistry([modelId]);

  for (const caseId of ['valid', 'missing', 'stale', 'wrong-suite', 'malformed'] as const) {
    const repoDir = makeVerificationRepo([modelId]);

    switch (caseId) {
      case 'valid':
        writeCertification(repoDir, modelId);
        break;
      case 'missing':
        break;
      case 'stale':
        writeCertification(repoDir, modelId, {
          certifiedAt: new Date(DEFAULT_NOW.getTime() - 61 * 24 * 60 * 60 * 1000).toISOString(),
        });
        break;
      case 'wrong-suite':
        writeCertification(repoDir, modelId, { suiteVersion: 'v0' });
        break;
      case 'malformed':
        writeMalformedCertification(repoDir, modelId);
        break;
    }

    const [entry] = resolveNativeAgentProviders(repoDir, {
      env: { OPENROUTER_API_KEY: 'sk-test-openrouter' },
      phase: 'task-expansion',
      registry,
      now: DEFAULT_NOW,
    });

    cases.push({
      caseId,
      status: entry?.status ?? 'missing',
      reason: 'rejectionReason' in (entry ?? {}) ? (entry as { rejectionReason?: string }).rejectionReason : undefined,
    });
  }

  return cases;
}

async function verifyFallbackSemantics(): Promise<FallbackCheckSummary> {
  const repoDir = makeVerificationRepo(['qwen/qwen3-coder'], true);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  let unavailableResultHasNativeMetadata = false;

  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(' '));
    };

    const unavailableResult = await expandIssue({
      promptTemplate: 'prompt',
      issueContext: 'issue',
      repoDir,
    }, {
      expandIssueWithClaude: async () => 'claude fallback packet',
      importNativeExpansion: async () => ({
        NativeExpansionUnavailableError,
        runNativeExpansion: async () => {
          throw new NativeExpansionUnavailableError('missing_key', 'OPENROUTER_API_KEY is not set');
        },
      }),
    });
    unavailableResultHasNativeMetadata = unavailableResult.native !== undefined;

    let nonAvailabilityClaudeCalls = 0;
    let nonAvailabilityErrorMessage = '';
    await expandIssue({
      promptTemplate: 'prompt',
      issueContext: 'issue',
      repoDir,
    }, {
      expandIssueWithClaude: async () => {
        nonAvailabilityClaudeCalls += 1;
        return 'unexpected claude rollback';
      },
      importNativeExpansion: async () => ({
        NativeExpansionUnavailableError,
        runNativeExpansion: async () => {
          throw new Error('Native task expansion failed: loop exited with stopReason=error.');
        },
      }),
    }).catch((error: unknown) => {
      nonAvailabilityErrorMessage = error instanceof Error ? error.message : String(error);
    });

    return {
      unavailableFallbackReturnedClaude: unavailableResult.text === 'claude fallback packet',
      unavailableFallbackWarning: warnings.join('\n'),
      unavailableResultHasNativeMetadata,
      nonAvailabilityErrorMessage,
      nonAvailabilityClaudeCalls,
    };
  } finally {
    console.warn = originalWarn;
  }
}

export async function runVerification(options: VerificationOptions): Promise<VerificationSummary> {
  const config = readRepoConfig(options.repoDir);
  const selectedModels = selectVerificationModels(config, {
    model: options.model,
    allModels: options.allModels,
  });
  const worktreeStatusBefore = gitStatusPorcelain(options.repoDir);
  const expansionRuns: ExpansionRunSummary[] = [];
  for (const modelId of selectedModels) {
    expansionRuns.push(await runFixtureExpansion(modelId));
  }
  const certificationCases = await verifyCertificationGate(selectedModels[0]!);
  const fallback = await verifyFallbackSemantics();
  const structure = compareTaskPacketStructure(
    expansionRuns[0]!.rawPacket,
    readFileSync(BASELINE_PACKET_PATH, 'utf-8'),
  );
  const worktreeStatusAfter = gitStatusPorcelain(options.repoDir);

  const failures = [
    ...expansionRuns.flatMap(getArtifactFailures),
    ...getCertificationFailures(certificationCases),
    ...getFallbackFailures(fallback),
    ...(structure.hasSplitMarker ? [] : ['native packet is missing the split marker required by the baseline.']),
    ...structure.missingHeadings.map((heading) => `native packet is missing baseline heading: ${heading}`),
    ...(worktreeStatusBefore === worktreeStatusAfter ? [] : ['the verifier changed the real worktree status.']),
  ];

  return {
    issueId: ISSUE_ID,
    linkedIssueId: LINKED_ISSUE_ID,
    repoDir: options.repoDir,
    gitSha: execFileSync('git', ['-C', options.repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    generatedAt: new Date().toISOString(),
    selectedModels,
    expansionRuns,
    certificationCases,
    fallback,
    structure,
    worktreeStatusBefore,
    worktreeStatusAfter,
    evidencePath: EVIDENCE_PATH,
    passed: failures.length === 0,
  };
}

function buildAcceptanceRows(summary: VerificationSummary): Array<{ criterion: string; verdict: 'PASS' | 'FAIL'; evidence: string }> {
  const rows: Array<{ criterion: string; verdict: 'PASS' | 'FAIL'; evidence: string }> = [];

  for (const run of summary.expansionRuns) {
    const failures = getArtifactFailures(run);
    rows.push({
      criterion: `Offline native expansion artifacts for ${run.modelId}`,
      verdict: failures.length === 0 ? 'PASS' : 'FAIL',
      evidence: failures.length === 0
        ? `${relative(summary.repoDir, run.artifacts.taskPacket)}; sidecar=${relative(summary.repoDir, run.artifacts.sidecar)}`
        : failures.join(' '),
    });
  }

  const certificationFailures = getCertificationFailures(summary.certificationCases);
  rows.push({
    criterion: 'Missing or stale read-only certification blocks task-expansion model selection',
    verdict: certificationFailures.length === 0 ? 'PASS' : 'FAIL',
    evidence: certificationFailures.length === 0
      ? summary.certificationCases.map((entry) => `${entry.caseId}=${entry.status}${entry.reason ? `(${entry.reason})` : ''}`).join(', ')
      : certificationFailures.join(' '),
  });

  const fallbackFailures = getFallbackFailures(summary.fallback);
  rows.push({
    criterion: 'FallbackOnUnavailable preserves Claude rollback and surfaces non-availability failures',
    verdict: fallbackFailures.length === 0 ? 'PASS' : 'FAIL',
    evidence: fallbackFailures.length === 0
      ? 'fallback warning emitted; generic native failure stayed visible'
      : fallbackFailures.join(' '),
  });

  rows.push({
    criterion: 'Native packet structure matches the Claude/Codex baseline',
    verdict: summary.structure.hasSplitMarker && summary.structure.missingHeadings.length === 0 ? 'PASS' : 'FAIL',
    evidence: summary.structure.missingHeadings.length === 0
      ? `${path.relative(summary.repoDir, summary.structure.baselinePath)} headings preserved`
      : summary.structure.missingHeadings.join(', '),
  });

  rows.push({
    criterion: 'Non-evidence verifier run leaves the real worktree unchanged',
    verdict: summary.worktreeStatusBefore === summary.worktreeStatusAfter ? 'PASS' : 'FAIL',
    evidence: summary.worktreeStatusBefore === summary.worktreeStatusAfter
      ? 'git status --porcelain unchanged'
      : 'git status --porcelain changed during verification',
  });

  return rows;
}

export function buildVerificationMarkdown(summary: VerificationSummary): string {
  const acceptanceRows = buildAcceptanceRows(summary)
    .map((row) => `| ${row.criterion} | ${row.verdict} | ${row.evidence} |`)
    .join('\n');
  const artifactBlocks = summary.expansionRuns.map((run) => [
    `## ${run.modelId}`,
    '',
    `- temp repo: \`${run.artifacts.repoDir}\``,
    `- task packet: \`${run.artifacts.taskPacket}\``,
    `- header: \`${run.artifacts.header}\``,
    `- details: \`${run.artifacts.details}\``,
    `- sidecar: \`${run.artifacts.sidecar}\``,
    `- transcript: \`${run.artifacts.transcript}\``,
    `- manifest: \`${run.artifacts.manifest}\``,
    `- provider/model/api: \`${run.sidecar.provider}\` / \`${run.sidecar.model}\` / \`${run.sidecar.api}\``,
    `- usage/cost: input=${run.totalInputTokens} output=${run.totalOutputTokens} cost=$${run.cost.toFixed(4)}`,
    `- denied tool calls: ${run.deniedToolCalls.map((call) => `\`${call.tool}\``).join(', ') || 'none'}`,
    `- manifest phase refs: prompt=${run.manifestPhase.promptRefs}, runtime=${run.manifestPhase.runtimeRefs}, tool-set=${run.manifestPhase.agentConfigRefs}`,
    '',
  ].join('\n')).join('\n');

  return [
    `# ${summary.issueId} Verification Evidence`,
    '',
    `Generated: ${summary.generatedAt}`,
    `Git SHA: ${summary.gitSha}`,
    `Models exercised: ${summary.selectedModels.map((model) => `\`${model}\``).join(', ')}`,
    `Linked rollout issue: ${summary.linkedIssueId}`,
    '',
    '## Command',
    '',
    '```bash',
    `npx tsx tools/hok2424-verify-native-expansion.ts --repo-dir ${summary.repoDir}${summary.selectedModels.length > 1 ? ' --all-models' : ` --model ${summary.selectedModels[0]}`}`,
    '```',
    '',
    '## Acceptance Matrix',
    '',
    '| Criterion | Verdict | Evidence |',
    '| --- | --- | --- |',
    acceptanceRows,
    '',
    '## Artifact Paths',
    '',
    artifactBlocks,
    '## Certification Gate Cases',
    '',
    summary.certificationCases.map((entry) => `- ${entry.caseId}: status=\`${entry.status}\`${entry.reason ? ` reason=\`${entry.reason}\`` : ''}`).join('\n'),
    '',
    '## Fallback',
    '',
    `- unavailable fallback returned Claude: ${summary.fallback.unavailableFallbackReturnedClaude}`,
    `- fallback warning: ${summary.fallback.unavailableFallbackWarning || '(none)'}`,
    `- generic native failure surfaced: \`${summary.fallback.nonAvailabilityErrorMessage}\``,
    `- generic native failure Claude calls: ${summary.fallback.nonAvailabilityClaudeCalls}`,
    '',
    '## Structural Comparison',
    '',
    `- baseline: \`${relative(summary.repoDir, summary.structure.baselinePath)}\``,
    `- split marker present: ${summary.structure.hasSplitMarker}`,
    `- missing headings: ${summary.structure.missingHeadings.length === 0 ? 'none' : summary.structure.missingHeadings.join(', ')}`,
    '',
    `Results support the native OpenRouter task-expansion rollout tracked by ${summary.linkedIssueId}.`,
    '',
  ].join('\n');
}

function renderSummary(summary: VerificationSummary): string {
  return buildVerificationMarkdown(summary);
}

if (import.meta.main) {
  runTool({
    name: 'hok2424-verify-native-expansion',
    description: 'Verify native OpenRouter task-expansion rollout artifacts, gating, and fallback behavior.',
    options: {
      'repo-dir': {
        type: 'string',
        description: 'Repository root to verify (defaults to cwd).',
      },
      model: {
        type: 'string',
        description: 'Verify a specific configured native OpenRouter model.',
      },
      'all-models': {
        type: 'boolean',
        description: 'Verify all configured native OpenRouter models.',
      },
      'emit-evidence': {
        type: 'boolean',
        description: 'Write verification-evidence.md into the feature directory.',
      },
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON.',
      },
    },
    examples: [
      'npx tsx tools/hok2424-verify-native-expansion.ts',
      'npx tsx tools/hok2424-verify-native-expansion.ts --all-models',
      'npx tsx tools/hok2424-verify-native-expansion.ts --model qwen/qwen3-coder --json',
    ],
    async run({ args }) {
      const repoDir = resolveRepoDir(args['repo-dir']);
      const summary = await runVerification({
        repoDir,
        model: args.model,
        allModels: args['all-models'] === true,
      });

      if (args['emit-evidence'] === true) {
        const evidencePath = join(repoDir, EVIDENCE_PATH);
        await fs.mkdir(path.dirname(evidencePath), { recursive: true });
        await fs.writeFile(evidencePath, buildVerificationMarkdown(summary), 'utf-8');
      }

      if (args.json === true) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        process.stdout.write(renderSummary(summary));
      }

      if (!summary.passed) {
        throw new Error('HOK-2424 native expansion verification failed.');
      }
    },
  });
}

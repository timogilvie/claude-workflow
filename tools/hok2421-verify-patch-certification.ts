#!/usr/bin/env -S npx tsx

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearConfigCache, loadWavemillBaseConfig } from '../shared/lib/config.ts';
import { resolveExpansionDispatch } from '../shared/lib/issue-expander.ts';
import { resolveModelAgent } from '../shared/lib/model-agent-resolution.ts';
import { getEffectiveRegistry, type ModelRegistry } from '../shared/lib/model-registry.ts';
import { launchNativePlanning } from '../shared/lib/native-agent/launch-planning.ts';
import {
  filterNativeModels,
  type RouterCertificationRejection,
} from '../shared/lib/native-agent/certification/router-filter.ts';
import { buildCertificationPath } from '../shared/lib/native-agent/certification/loader.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/schema.ts';
import { resolveCertificationStorageIdentity } from '../shared/lib/native-agent/certification/identity.ts';
import { writeCertification } from '../shared/lib/native-agent/certification/store.ts';
import { registerScriptedPiProvider } from '../shared/lib/native-agent/provider.ts';
import { runNativeReview, nativeReviewTestUtils } from '../shared/lib/native-agent/review.ts';
import type { ReadyNativeProviderEntry } from '../shared/lib/native-agent/providers.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  writePatchCodingCertification,
  type PatchCodingCertification,
} from '../shared/lib/native-agent/coding-certification.ts';
import { isPatchCodingEnabled } from '../shared/lib/native-agent/coding-gate.ts';
import { runNativeExpansion } from '../shared/lib/native-expansion.ts';
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';
import { isNativeReviewOptedIn } from '../shared/lib/review-engine.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from '../shared/lib/native-agent/smoke.ts';
import { checkNativeEligibility } from './check-native-eligibility.ts';

const MODELS = [
  'qwen/qwen3-coder',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k2.7-code',
] as const;

const NOW = new Date('2026-07-10T12:00:00.000Z');
const STALE_CERTIFIED_AT = '2026-01-01T00:00:00.000Z';
const FEATURE_SLUG = 'verify-patch-path-certification-gates-all-phase-native-openrouter-rollout';
const DEFAULT_EVIDENCE_PATH = `features/${FEATURE_SLUG}/verification-evidence.md`;

type NegativeCaseName = 'missing' | 'stale' | 'malformed' | 'wrong-suite' | 'read-only-only';

interface CertificationCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  parsed: {
    provider: string;
    model: string;
    phase: string;
    suiteVersion: string;
    dryRun: boolean;
    harnessPassed: boolean;
    liveCertifiable: boolean;
    artifactPath?: string;
    scenarios?: Array<{ scenarioId: string; status: string; detail?: string }>;
    knownLimitations?: string[];
  };
  commandArtifactPath?: string;
  verificationArtifactPath: string;
  artifactSource: 'command' | 'fixture';
  artifact: NativeCertificationArtifact;
}

interface ModelVerificationResult {
  modelId: string;
  certification: CertificationCommandResult;
  positiveEligibility: {
    eligible: string[];
    rejected: RouterCertificationRejection[];
  };
  negativeEligibility: Record<NegativeCaseName, RouterCertificationRejection>;
}

interface PatchCodingVerificationResult {
  missing: ReturnType<typeof isPatchCodingEnabled>;
  stale: ReturnType<typeof isPatchCodingEnabled>;
  valid: ReturnType<typeof isPatchCodingEnabled>;
}

interface FixtureResult {
  expansion: {
    transcriptPath: string;
    model: string;
    provider: string;
    deniedToolCalls: ReadonlyArray<{ tool: string; reason: string }>;
  };
  planning: {
    planPath: string;
    approvalMarkerPath: string;
    hookPath: string;
    stopReason: string;
  };
  review: {
    verdict: string;
    findingCount: number;
  };
  codingGate: ReturnType<typeof isPatchCodingEnabled>;
}

interface RollbackResult {
  nativeDisabled: RollbackScenarioResult;
  phasesRemoved: RollbackScenarioResult;
}

interface RollbackScenarioResult {
  expansionDispatch: ReturnType<typeof resolveExpansionDispatch>;
  planningEligibility: ReturnType<typeof checkNativeEligibility>;
  reviewOptedIn: boolean;
  hostedFallbacks: {
    planner: ReturnType<typeof resolveModelAgent>;
    coder: ReturnType<typeof resolveModelAgent>;
    reviewer: ReturnType<typeof resolveModelAgent>;
  };
}

interface VerificationReport {
  ok: boolean;
  repoDir: string;
  verificationRoot: string;
  modelResults: ModelVerificationResult[];
  patchCoding: PatchCodingVerificationResult;
  fixture: FixtureResult;
  rollback: RollbackResult;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

function parseArgs(argv: string[]): { repoDir: string; evidencePath?: string } {
  let repoDir = process.cwd();
  let evidencePath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      repoDir = resolve(argv[index + 1] ?? repoDir);
      index += 1;
      continue;
    }
    if (arg === '--evidence') {
      evidencePath = resolve(argv[index + 1] ?? DEFAULT_EVIDENCE_PATH);
      index += 1;
      continue;
    }
  }

  return { repoDir, evidencePath };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function createConfigRepo(parentDir: string, baseRepo: string, label: string, configOverride?: unknown): string {
  const repoDir = mkdtempSync(join(parentDir, `${label}-`));
  const config = configOverride ?? loadWavemillBaseConfig(baseRepo);
  writeJson(join(repoDir, '.wavemill-config.json'), config);
  clearConfigCache(repoDir);
  return repoDir;
}

function cleanupRepo(repoDir: string): void {
  clearConfigCache(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
}

function setupGitFixture(repoDir: string): { featureDir: string; taskPacketPath: string; sourcePath: string } {
  execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'hok2421@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'HOK-2421 Fixture'], { stdio: 'pipe' });

  const featureDir = join(repoDir, 'features', 'hok2421-fixture');
  const taskPacketPath = join(featureDir, 'task-packet.md');
  const sourcePath = join(repoDir, 'src.ts');
  mkdirSync(featureDir, { recursive: true });
  writeText(sourcePath, 'export const fixtureValue = 1;\n');
  writeText(taskPacketPath, '# Task Packet\n\n## Objective\nPlaceholder packet for HOK-2421.\n');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'fixture'], { stdio: 'pipe' });

  return { featureDir, taskPacketPath, sourcePath };
}

function loadArtifact(path: string): NativeCertificationArtifact {
  return JSON.parse(readFileSync(path, 'utf8')) as NativeCertificationArtifact;
}

function buildFixturePatchArtifact(
  modelId: string,
  suiteVersion: string,
  commandResult: CertificationCommandResult['parsed'],
): NativeCertificationArtifact {
  const identity = resolveCertificationStorageIdentity('openrouter', modelId);
  const deterministicScenarios = (commandResult.scenarios ?? [])
    .filter((scenario) => scenario.status !== 'not-run')
    .map((scenario) => ({
      scenarioId: scenario.scenarioId,
      passed: scenario.status === 'pass',
      ...(scenario.detail ? { failureMessage: scenario.detail } : {}),
    }));

  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: identity.provider,
    model: identity.model,
    phase: 'patch',
    suiteVersion,
    certifiedAt: NOW.toISOString(),
    scenarios: deterministicScenarios,
    knownLimitations: [
      ...(commandResult.knownLimitations ?? []),
      'HOK-2421 verification synthesized a fresh patch artifact because suite v1 does not yet persist phase=patch certifications.',
    ],
  };
}

function writeArtifact(
  repoDir: string,
  modelId: string,
  suiteVersion: string,
  artifact: NativeCertificationArtifact,
): string {
  const path = buildCertificationPath(repoDir, 'openrouter', modelId, suiteVersion);
  writeJson(path, artifact);
  return path;
}

function buildNegativeArtifact(
  base: NativeCertificationArtifact,
  negativeCase: Exclude<NegativeCaseName, 'missing' | 'malformed'>,
): NativeCertificationArtifact {
  if (negativeCase === 'stale') {
    return { ...base, certifiedAt: STALE_CERTIFIED_AT };
  }
  if (negativeCase === 'wrong-suite') {
    return { ...base, suiteVersion: 'v-wrong-suite' };
  }
  return { ...base, phase: 'read-only' };
}

function expectSingleRejection(
  result: { eligible: string[]; rejected: RouterCertificationRejection[] },
  modelId: string,
  expectedReason: RouterCertificationRejection['reason'],
): RouterCertificationRejection {
  if (result.eligible.length !== 0) {
    throw new Error(`${modelId} unexpectedly remained eligible: ${JSON.stringify(result.eligible)}`);
  }
  if (result.rejected.length !== 1) {
    throw new Error(`${modelId} expected exactly one rejection, saw ${result.rejected.length}`);
  }
  const [rejection] = result.rejected;
  if (rejection.reason !== expectedReason) {
    throw new Error(`${modelId} expected reason=${expectedReason}, saw ${rejection.reason}`);
  }
  return rejection;
}

function makePatchCodingCertification(overrides: Partial<PatchCodingCertification> = {}): PatchCodingCertification {
  return {
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: '2026-07-10T12:00:00.000Z',
    providers: [
      { provider: 'openrouter', model: 'qwen/qwen3-coder', passed: true },
      { provider: 'openai', model: 'gpt-5.5', passed: true },
    ],
    ...overrides,
  };
}

function runCertifyCommand(baseRepo: string, repoDir: string, modelId: string): CertificationCommandResult {
  const command = `npx tsx tools/native-agent-certify.ts --provider openrouter --model ${modelId} --phase patch --json --repo ${repoDir}`;
  const result = spawnSync(
    'npx',
    ['tsx', 'tools/native-agent-certify.ts', '--provider', 'openrouter', '--model', modelId, '--phase', 'patch', '--json', '--repo', repoDir],
    {
      cwd: baseRepo,
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Certification command failed for ${modelId}`,
      command,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }

  const stdout = result.stdout.trim();
  const parsed = JSON.parse(stdout) as CertificationCommandResult['parsed'];
  let commandArtifactPath: string | undefined;
  let verificationArtifactPath: string;
  let artifactSource: CertificationCommandResult['artifactSource'];

  if (parsed.artifactPath) {
    commandArtifactPath = resolve(parsed.artifactPath);
    verificationArtifactPath = commandArtifactPath;
    artifactSource = 'command';
  } else {
    const fixtureArtifact = buildFixturePatchArtifact(modelId, parsed.suiteVersion, parsed);
    verificationArtifactPath = writeCertification(repoDir, fixtureArtifact);
    artifactSource = 'fixture';
  }
  const artifact = loadArtifact(verificationArtifactPath);

  return {
    command,
    stdout,
    stderr: result.stderr.trim(),
    parsed,
    commandArtifactPath,
    verificationArtifactPath,
    artifactSource,
    artifact,
  };
}

function verifyModel(
  verificationRoot: string,
  baseRepo: string,
  registry: ModelRegistry,
  modelId: string,
  checks: VerificationReport['checks'],
): ModelVerificationResult {
  const repoDir = createConfigRepo(verificationRoot, baseRepo, `hok2421-model-${modelId.replace(/[^a-z0-9]+/gi, '-')}`);
  const certification = runCertifyCommand(baseRepo, repoDir, modelId);
  const positiveEligibility = filterNativeModels([modelId], 'coder', registry, repoDir, NOW);
  checks.push({
    name: `${modelId} accepts fresh patch artifact`,
    passed: positiveEligibility.eligible.includes(modelId) && positiveEligibility.rejected.length === 0,
    detail: JSON.stringify(positiveEligibility),
  });

  if (!positiveEligibility.eligible.includes(modelId) || positiveEligibility.rejected.length > 0) {
    throw new Error(`Fresh patch artifact was rejected for ${modelId}: ${JSON.stringify(positiveEligibility)}`);
  }

  const negativeExpectations: Record<NegativeCaseName, RouterCertificationRejection['reason']> = {
    missing: 'missing',
    stale: 'stale',
    malformed: 'malformed',
    'wrong-suite': 'wrong-suite',
    'read-only-only': 'insufficient-phase',
  };
  const negativeEligibility = {} as Record<NegativeCaseName, RouterCertificationRejection>;

  for (const negativeCase of Object.keys(negativeExpectations) as NegativeCaseName[]) {
    const negativeRepo = createConfigRepo(verificationRoot, baseRepo, `hok2421-negative-${negativeCase}-${modelId.replace(/[^a-z0-9]+/gi, '-')}`);
    try {
      if (negativeCase === 'malformed') {
        const path = buildCertificationPath(negativeRepo, 'openrouter', modelId, certification.parsed.suiteVersion);
        writeText(path, '{"schemaVersion":');
      } else if (negativeCase !== 'missing') {
        writeArtifact(
          negativeRepo,
          modelId,
          certification.parsed.suiteVersion,
          buildNegativeArtifact(certification.artifact, negativeCase),
        );
      }

      const result = filterNativeModels([modelId], 'coder', registry, negativeRepo, NOW);
      const rejection = expectSingleRejection(result, modelId, negativeExpectations[negativeCase]);
      negativeEligibility[negativeCase] = rejection;
      checks.push({
        name: `${modelId} rejects ${negativeCase}`,
        passed: rejection.reason === negativeExpectations[negativeCase],
        detail: JSON.stringify(rejection),
      });
    } finally {
      cleanupRepo(negativeRepo);
    }
  }

  return {
    modelId,
    certification,
    positiveEligibility,
    negativeEligibility,
  };
}

function verifyPatchCoding(verificationRoot: string, baseRepo: string, checks: VerificationReport['checks']): PatchCodingVerificationResult {
  const config = deepClone(loadWavemillBaseConfig(baseRepo));
  config.nativeAgent = {
    ...(config.nativeAgent ?? {}),
    patchCoding: { enabled: true },
  };
  const repoDir = createConfigRepo(verificationRoot, baseRepo, 'hok2421-patch-coding', config);
  try {
    const missing = isPatchCodingEnabled(repoDir);
    checks.push({
      name: 'patch coding missing alpha artifact is rejected',
      passed: missing.enabled === false && missing.reason === 'missing',
      detail: JSON.stringify(missing),
    });

    writePatchCodingCertification(repoDir, makePatchCodingCertification({
      smokeSuiteRevision: 'patch-coding-smoke-v0',
    }));
    const stale = isPatchCodingEnabled(repoDir);
    checks.push({
      name: 'patch coding stale alpha artifact is rejected',
      passed: stale.enabled === false && stale.reason === 'revision_mismatch',
      detail: JSON.stringify(stale),
    });

    writePatchCodingCertification(repoDir, makePatchCodingCertification());
    const valid = isPatchCodingEnabled(repoDir);
    checks.push({
      name: 'patch coding only enables with valid alpha artifact',
      passed: valid.enabled === true && valid.reason === 'enabled',
      detail: JSON.stringify(valid),
    });

    return { missing, stale, valid };
  } finally {
    cleanupRepo(repoDir);
  }
}

async function verifyFixture(verificationRoot: string, baseRepo: string, checks: VerificationReport['checks']): Promise<FixtureResult> {
  const config = deepClone(loadWavemillBaseConfig(baseRepo));
  config.nativeAgent = {
    ...(config.nativeAgent ?? {}),
    patchCoding: { enabled: true },
  };

  const repoDir = createConfigRepo(verificationRoot, baseRepo, 'hok2421-fixture', config);
  const { featureDir, taskPacketPath } = setupGitFixture(repoDir);
  try {
    const readyProvider = resolveNativeAgentProviders(repoDir, {
      env: { OPENROUTER_API_KEY: 'fixture-key' },
      phase: 'task-expansion',
      registry: getEffectiveRegistry(repoDir),
    }).find((entry): entry is ReadyNativeProviderEntry => entry.status === 'ready');
    if (!readyProvider) {
      throw new Error('Fixture could not resolve a ready native OpenRouter provider for expansion');
    }

    const promptTemplate = await loadPromptTemplate(join(baseRepo, 'tools/prompts/issue-writer.md'));

    registerScriptedPiProvider({
      api: String(readyProvider.model.api),
      provider: 'openrouter',
      turns: [{
        content: [{
          type: 'text',
          text: [
            '# Task Packet',
            '',
            '## Objective',
            'Verify native OpenRouter read-only phases and patch-coding gating.',
            '',
            '## Requirements',
            '- Keep review, planning, and expansion read-only.',
            '- Do not run native coding without a separate alpha certification artifact.',
            '',
            '## Release Readiness',
            '- database_change_risk: none',
          ].join('\n'),
        }],
        stopReason: 'stop',
      }],
    });

    const expansion = await runNativeExpansion({
      promptTemplate,
      issueContext: 'Issue: HOK-2421-FIXTURE',
      codebaseContext: 'Relevant files: native-expansion.ts, launch-planning.ts, review.ts, coding-gate.ts',
      mode: 'normal',
      repoDir,
      issueId: 'HOK-2421-FIXTURE',
      env: {
        OPENROUTER_API_KEY: 'fixture-key',
        WAVEMILL_SESSION: `hok2421-expansion-${Date.now()}`,
        WAVEMILL_ISSUE: 'HOK-2421-FIXTURE',
      },
    });
    writeText(taskPacketPath, `${expansion.text.trim()}\n`);
    checks.push({
      name: 'fixture task expansion completed',
      passed: existsSync(expansion.native.transcriptPath),
      detail: JSON.stringify(expansion.native),
    });

    registerScriptedPiProvider({
      api: String(readyProvider.model.api),
      provider: 'openrouter',
      turns: [{
        content: [{
          type: 'text',
          text: [
            '# Implementation Plan',
            '',
            '## Phase 1',
            '- Reuse existing certification helpers.',
            '',
            '## Phase 2',
            '- Verify patch gating and rollback behavior.',
            '',
            '## Release Readiness',
            '- database_change_risk: none',
          ].join('\n'),
        }],
        stopReason: 'stop',
      }],
    });

    const planning = await launchNativePlanning({
      session: `hok2421-planning-${Date.now()}`,
      issue: 'HOK-2421-FIXTURE',
      slug: 'hok2421-fixture',
      wtDir: repoDir,
      repoDir,
      title: 'Verify native OpenRouter phases',
      providerEntries: [readyProvider],
      runTsxCommand: (args: string[]) => {
        const outputIndex = args.indexOf('--output');
        if (outputIndex >= 0) {
          writeText(args[outputIndex + 1]!, `${JSON.stringify({
            planner: 'claude-sonnet-5',
            coder: 'gpt-5.5',
            reviewer: 'claude-sonnet-5',
            planDepth: 'light',
          }, null, 2)}\n`);
        }
        return '';
      },
    });
    checks.push({
      name: 'fixture planning completed',
      passed: existsSync(planning.planPath) && existsSync(planning.approvalMarkerPath),
      detail: JSON.stringify(planning),
    });

    registerScriptedPiProvider({
      api: String(readyProvider.model.api),
      provider: 'openrouter',
      turns: [{
        content: [{
          type: 'text',
          text: JSON.stringify({
            verdict: 'ready',
            codeReviewFindings: [],
          }),
        }],
        stopReason: 'stop',
      }],
    });

    nativeReviewTestUtils.setSelectReviewProvider(() => ({
      ok: true,
      entry: readyProvider,
    }));
    nativeReviewTestUtils.setGetNativeProviderApiKey(() => 'fixture-key');

    const review = await runNativeReview({
      diff: 'diff --git a/src.ts b/src.ts',
      plan: readFileSync(planning.planPath, 'utf8'),
      taskPacket: readFileSync(taskPacketPath, 'utf8'),
      designContext: null,
      metadata: {
        branch: 'feature/hok2421-fixture',
        files: ['src.ts'],
        hasUiChanges: false,
      },
    }, repoDir, {});
    nativeReviewTestUtils.resetDeps();
    checks.push({
      name: 'fixture review completed',
      passed: review.verdict === 'ready',
      detail: JSON.stringify({ verdict: review.verdict, findings: review.codeReviewFindings.length }),
    });

    const codingGate = isPatchCodingEnabled(repoDir);
    checks.push({
      name: 'fixture coding gate blocks uncertified native coding',
      passed: codingGate.enabled === false && codingGate.reason === 'missing',
      detail: JSON.stringify(codingGate),
    });

    return {
      expansion: {
        transcriptPath: expansion.native.transcriptPath,
        model: expansion.native.model,
        provider: expansion.native.provider,
        deniedToolCalls: expansion.native.deniedToolCalls,
      },
      planning: {
        planPath: planning.planPath,
        approvalMarkerPath: planning.approvalMarkerPath,
        hookPath: planning.hookPath,
        stopReason: planning.stopReason,
      },
      review: {
        verdict: review.verdict,
        findingCount: review.codeReviewFindings.length,
      },
      codingGate,
    };
  } finally {
    nativeReviewTestUtils.resetDeps();
  }
}

function verifyRollback(verificationRoot: string, baseRepo: string, checks: VerificationReport['checks']): RollbackResult {
  const baseConfig = loadWavemillBaseConfig(baseRepo);
  const makeScenario = (config: unknown): RollbackScenarioResult => {
    const repoDir = createConfigRepo(verificationRoot, baseRepo, 'hok2421-rollback', config);
    try {
      return {
        expansionDispatch: resolveExpansionDispatch(repoDir),
        planningEligibility: checkNativeEligibility(repoDir, 'planning'),
        reviewOptedIn: isNativeReviewOptedIn(repoDir),
        hostedFallbacks: {
          planner: resolveModelAgent({ model: 'claude-sonnet-5', phase: 'planning', repoDir }),
          coder: resolveModelAgent({ model: 'gpt-5.5', phase: 'coding', repoDir }),
          reviewer: resolveModelAgent({ model: 'claude-sonnet-5', phase: 'review', repoDir }),
        },
      };
    } finally {
      cleanupRepo(repoDir);
    }
  };

  const nativeDisabledConfig = deepClone(baseConfig);
  nativeDisabledConfig.nativeAgent = {
    ...(nativeDisabledConfig.nativeAgent ?? {}),
    enabled: false,
  };

  const phasesRemovedConfig = deepClone(baseConfig);
  phasesRemovedConfig.nativeAgent = {
    ...(phasesRemovedConfig.nativeAgent ?? {}),
    enabled: true,
    allowedPhases: [],
  };

  const nativeDisabled = makeScenario(nativeDisabledConfig);
  const phasesRemoved = makeScenario(phasesRemovedConfig);

  const rollbackChecks = [
    {
      name: 'rollback disables native task expansion when nativeAgent is off',
      passed: nativeDisabled.expansionDispatch.kind === 'default',
      detail: JSON.stringify(nativeDisabled.expansionDispatch),
    },
    {
      name: 'rollback disables native planning when nativeAgent is off',
      passed: nativeDisabled.planningEligibility.eligible === false && nativeDisabled.planningEligibility.reason === 'config_disabled',
      detail: JSON.stringify(nativeDisabled.planningEligibility),
    },
    {
      name: 'rollback disables native review when nativeAgent is off',
      passed: nativeDisabled.reviewOptedIn === false,
      detail: JSON.stringify({ reviewOptedIn: nativeDisabled.reviewOptedIn }),
    },
    {
      name: 'phase removal disables native task expansion',
      passed: phasesRemoved.expansionDispatch.kind === 'default',
      detail: JSON.stringify(phasesRemoved.expansionDispatch),
    },
    {
      name: 'phase removal disables native planning',
      passed: phasesRemoved.planningEligibility.eligible === false && phasesRemoved.planningEligibility.reason === 'phase_not_allowed',
      detail: JSON.stringify(phasesRemoved.planningEligibility),
    },
    {
      name: 'phase removal disables native review',
      passed: phasesRemoved.reviewOptedIn === false,
      detail: JSON.stringify({ reviewOptedIn: phasesRemoved.reviewOptedIn }),
    },
    {
      name: 'hosted Claude/Codex fallbacks remain resolvable',
      passed: [nativeDisabled, phasesRemoved].every((scenario) => (
        scenario.hostedFallbacks.planner.ok
        && scenario.hostedFallbacks.coder.ok
        && scenario.hostedFallbacks.reviewer.ok
      )),
      detail: JSON.stringify({
        nativeDisabled: nativeDisabled.hostedFallbacks,
        phasesRemoved: phasesRemoved.hostedFallbacks,
      }),
    },
  ];
  checks.push(...rollbackChecks);

  return { nativeDisabled, phasesRemoved };
}

async function runVerification(repoDir: string): Promise<VerificationReport> {
  const registry = getEffectiveRegistry(repoDir);
  const checks: VerificationReport['checks'] = [];
  const verificationRoot = mkdtempSync(join(tmpdir(), 'hok2421-verification-root-'));

  try {
    const modelResults = MODELS.map((modelId) => verifyModel(verificationRoot, repoDir, registry, modelId, checks));
    const patchCoding = verifyPatchCoding(verificationRoot, repoDir, checks);
    const fixture = await verifyFixture(verificationRoot, repoDir, checks);
    const rollback = verifyRollback(verificationRoot, repoDir, checks);
    const ok = checks.every((check) => check.passed);

    return {
      ok,
      repoDir,
      verificationRoot,
      modelResults,
      patchCoding,
      fixture,
      rollback,
      checks,
    };
  } catch (error) {
    rmSync(verificationRoot, { recursive: true, force: true });
    throw error;
  }
}

function renderMarkdown(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push('# HOK-2421 Verification Evidence');
  lines.push('');
  lines.push(`Verification root: \`${report.verificationRoot}\``);
  lines.push('');
  lines.push(`Overall result: **${report.ok ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push('## Harness Summary');
  lines.push('');
  for (const check of report.checks) {
    lines.push(`- ${check.passed ? 'PASS' : 'FAIL'} \`${check.name}\``);
  }
  lines.push('');
  lines.push('## Certification Commands');
  lines.push('');
  for (const modelResult of report.modelResults) {
    lines.push(`### ${modelResult.modelId}`);
    lines.push('');
    lines.push('```bash');
    lines.push(modelResult.certification.command);
    lines.push('```');
    lines.push('');
    lines.push('```json');
    lines.push(modelResult.certification.stdout);
    lines.push('```');
    lines.push('');
    if (modelResult.certification.commandArtifactPath) {
      lines.push(`Command artifact path: \`${modelResult.certification.commandArtifactPath}\``);
    } else {
      lines.push('Command artifact path: none persisted by `native-agent-certify --phase patch`.');
    }
    lines.push(`Verification artifact path: \`${modelResult.certification.verificationArtifactPath}\` (${modelResult.certification.artifactSource})`);
    lines.push('');
    lines.push('Fresh coder eligibility:');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(modelResult.positiveEligibility, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('Negative coder eligibility matrix:');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(modelResult.negativeEligibility, null, 2));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Patch Coding Gate');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.patchCoding, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## All-Phase Fixture');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.fixture, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Rollback');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.rollback, null, 2));
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { repoDir, evidencePath } = parseArgs(process.argv.slice(2));
  const report = await runVerification(repoDir);
  const markdown = renderMarkdown(report);

  if (evidencePath) {
    writeText(evidencePath, markdown);
  }

  process.stdout.write(markdown);
  if (!report.ok) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

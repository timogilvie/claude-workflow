import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertRegistryConsistency,
  ModelValidationError,
  validateNativeCapability,
  type ModelCapabilities,
  type ModelRegistry,
} from '../../model-registry.ts';
import { clearConfigCache } from '../../config.ts';
import { pickChallengeModelsWithReason, pickChallengeWorkflowsWithReason } from '../../challenge-mode.ts';
import { routeWorkflow, type WorkflowRouteDecision } from '../../workflow-router.ts';
import { certifyNativeAgent } from '../../../../tools/native-agent-certify.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  CERTIFICATION_TTL_DAYS,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  filterNativeModels,
  runScenarios,
  toArtifactScenario,
  validateCertification,
  type CertificationPhase,
  type HarnessReport,
  type HarnessScenarioResult,
  type NativeCertificationArtifact,
  type RouterCertificationRejection,
  type RouterCertificationRejectionReason,
  type RouterRole,
  type ScenarioAssertionOutcome,
  type ScenarioContext,
  type CertificationScenario,
} from './index.ts';

const NOW = new Date('2026-06-30T12:00:00.000Z');
const FRESH_CERTIFIED_AT = '2026-06-01T00:00:00.000Z';
const STALE_CERTIFIED_AT = new Date(
  NOW.getTime() - (CERTIFICATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000,
).toISOString();
const NON_NATIVE_A = 'claude-opus-4-6';
const NON_NATIVE_B = 'claude-sonnet-4-6';

function nativeCapability(phase: CertificationPhase = 'patch', suiteVersion = 'v1') {
  return {
    nativeProvider: 'openai' as const,
    piTransportKind: 'openai-responses' as const,
    readOnlyNative: 'certified' as const,
    certification: {
      maxCertifiedPhase: phase,
      certifiedAt: FRESH_CERTIFIED_AT,
      certificationSuiteVersion: suiteVersion,
    },
  };
}

function baseCapabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    vendor: 'openai',
    class: 'strong_generalist',
    strengths: [],
    weaknesses: [],
    qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
    contextWindowTokens: 128_000,
    toolSupport: 'full',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 2,
    ...overrides,
  };
}

function nativeModel(phase: CertificationPhase = 'patch', suiteVersion = 'v1'): ModelCapabilities {
  return baseCapabilities({ nativeCapability: nativeCapability(phase, suiteVersion) });
}

function nonNativeModel(vendor = 'anthropic'): ModelCapabilities {
  return baseCapabilities({ vendor });
}

function registry(models: Record<string, ModelCapabilities>): ModelRegistry {
  return { models, ladders: {} };
}

function makeRepo(models: Record<string, ModelCapabilities> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'rollout-regression-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'records.jsonl'), [
    JSON.stringify({ id: '1', modelId: NON_NATIVE_A, originalPrompt: 'Implement a feature', score: 0.9, timeSeconds: 200, interventionCount: 0 }),
    JSON.stringify({ id: '2', modelId: NON_NATIVE_A, originalPrompt: 'Fix a router bug', score: 0.92, timeSeconds: 190, interventionCount: 0 }),
    JSON.stringify({ id: '3', modelId: NON_NATIVE_B, originalPrompt: 'Implement a feature', score: 0.84, timeSeconds: 150, interventionCount: 0 }),
    JSON.stringify({ id: '4', modelId: NON_NATIVE_B, originalPrompt: 'Refactor code', score: 0.83, timeSeconds: 160, interventionCount: 1 }),
    '',
  ].join('\n'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    router: {
      enabled: true,
      mode: 'heuristic',
      defaultAgent: 'claude',
      defaultModel: NON_NATIVE_A,
      minRecords: 2,
      minModels: 1,
      agentMap: {
        [NON_NATIVE_A]: 'claude',
        [NON_NATIVE_B]: 'claude',
      },
    },
    modelRegistry: {
      models: Object.fromEntries(
        Object.entries(models).map(([modelId, capabilities]) => [
          modelId,
          {
            vendor: capabilities.vendor,
            class: capabilities.class,
            qualityScores: capabilities.qualityScores,
            nativeCapability: capabilities.nativeCapability,
          },
        ]),
      ),
    },
  }));
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function writeCertArtifact(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  overrides: Partial<NativeCertificationArtifact> & Record<string, unknown> = {},
): void {
  const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', provider, model);
  mkdirSync(certDir, { recursive: true });
  const artifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider,
    model,
    phase: 'patch',
    suiteVersion,
    certifiedAt: FRESH_CERTIFIED_AT,
    scenarios: [{ scenarioId: 'rollout.smoke', passed: true }],
    ...overrides,
  };
  writeFileSync(join(certDir, `${suiteVersion}.json`), JSON.stringify(artifact));
}

function writeMalformedCert(repoDir: string, provider: string, model: string, suiteVersion = 'v1'): void {
  const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', provider, model);
  mkdirSync(certDir, { recursive: true });
  writeFileSync(join(certDir, `${suiteVersion}.json`), JSON.stringify({ schemaVersion: CERTIFICATION_SCHEMA_VERSION, provider }));
}

function expectNativeRejection(
  rejections: readonly RouterCertificationRejection[] | undefined,
  modelId: string,
  role: RouterRole,
  reason: RouterCertificationRejectionReason,
): RouterCertificationRejection {
  const rejection = (rejections ?? []).find((item) => item.modelId === modelId && item.role === role);
  assert.ok(rejection, `[router-selection] expected ${role} rejection for ${modelId}`);
  assert.equal(rejection.reason, reason, `[router-selection] rejection reason should identify ${reason}`);
  assert.equal(rejection.modelId, modelId, '[router-selection] rejection should identify model');
  assert.equal(rejection.role, role, '[router-selection] rejection should identify role');
  assert.ok(rejection.requestedPhase, '[router-selection] rejection should identify requested phase');
  assert.equal(rejection.nativeCapability, 'certified', '[router-selection] rejection should identify native capability');
  assert.ok(rejection.requiredSuiteVersion.length > 0, '[router-selection] rejection should identify required suite');
  return rejection;
}

function scenario(
  id: string,
  outcomes: ScenarioAssertionOutcome[],
  phase: CertificationPhase = 'read-only',
): CertificationScenario {
  let index = 0;
  return {
    id,
    phase,
    category: 'tool',
    classification: 'deterministic',
    description: `Rollout regression scenario ${id}`,
    assertion: async (_ctx: ScenarioContext) => outcomes[Math.min(index++, outcomes.length - 1)],
  };
}

function passingReport(overrides: Partial<HarnessReport> = {}): HarnessReport {
  const result: HarnessScenarioResult = {
    scenarioId: 'rollout.pass',
    category: 'tool',
    classification: 'deterministic',
    phase: 'read-only',
    status: 'pass',
    attempts: 1,
    finalAttemptStatus: 'pass',
    durationMs: 1,
  };
  return {
    provider: 'openai',
    model: 'native-command',
    transport: 'openai-responses',
    results: [result],
    countsByStatus: { pass: 1, fail: 0, unsupported: 0, 'not-run': 0 },
    countsByCategory: { tool: 1, usage: 0, transcript: 0, phase: 0 },
    knownLimitations: [],
    harnessPassed: true,
    liveCertifiable: true,
    dryRun: false,
    ...overrides,
  };
}

describe('Epic 9 rollout regression: [registry-metadata]', () => {
  it('[registry-metadata] accepts valid native certification metadata consistently', () => {
    const models = {
      'native-valid': nativeModel('workflow', 'v1'),
      [NON_NATIVE_A]: nonNativeModel(),
    };

    assert.doesNotThrow(
      () => validateNativeCapability('native-valid', models['native-valid']),
      '[registry-metadata] valid native capability should pass validation',
    );
    assert.doesNotThrow(
      () => assertRegistryConsistency(registry(models)),
      '[registry-metadata] registry consistency should accept valid native certification metadata',
    );
  });

  it('[registry-metadata] rejects malformed native certification metadata with clear fields', () => {
    const cases: Array<[string, ModelCapabilities, RegExp]> = [
      ['missing-provider', baseCapabilities({ nativeCapability: { ...nativeCapability(), nativeProvider: undefined } as any }), /nativeProvider/],
      ['missing-transport', baseCapabilities({ nativeCapability: { ...nativeCapability(), piTransportKind: undefined } as any }), /piTransportKind/],
      ['bad-phase', baseCapabilities({ nativeCapability: { ...nativeCapability(), certification: { ...nativeCapability().certification, maxCertifiedPhase: 'bad' } } as any }), /maxCertifiedPhase/],
      ['bad-certified-at', baseCapabilities({ nativeCapability: { ...nativeCapability(), certification: { ...nativeCapability().certification, certifiedAt: 'not-a-date' } } as any }), /certifiedAt/],
      ['unsafe-suite', baseCapabilities({ nativeCapability: { ...nativeCapability(), certification: { ...nativeCapability().certification, certificationSuiteVersion: '../v1' } } as any }), /certificationSuiteVersion/],
      ['bad-limitations', baseCapabilities({ nativeCapability: { ...nativeCapability(), certification: { ...nativeCapability().certification, knownLimitations: ['ok', 1] } } as any }), /knownLimitations/],
    ];

    for (const [modelId, capabilities, message] of cases) {
      assert.throws(
        () => validateNativeCapability(modelId, capabilities),
        (error: unknown) => {
          assert.ok(error instanceof ModelValidationError, '[registry-metadata] failure should use ModelValidationError');
          assert.equal(error.modelId, modelId, '[registry-metadata] failure should identify model');
          assert.match(error.message, message, `[registry-metadata] failure should identify ${message}`);
          return true;
        },
      );
    }
  });
});

describe('Epic 9 rollout regression: [router-selection]', () => {
  it('[router-selection] applies phase semantics and rejects insufficient phases directly', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeCertArtifact(repoDir, 'openai', 'native-readonly', 'v1', { phase: 'read-only' });
      writeCertArtifact(repoDir, 'openai', 'native-patch', 'v1', { phase: 'patch' });
      writeCertArtifact(repoDir, 'openai', 'native-workflow', 'v1', { phase: 'workflow' });
      const modelRegistry = registry({
        'native-readonly': nativeModel('read-only'),
        'native-patch': nativeModel('patch'),
        'native-workflow': nativeModel('workflow'),
      });

      assert.deepEqual(
        filterNativeModels(['native-readonly'], 'reviewer', modelRegistry, repoDir, NOW).eligible,
        ['native-readonly'],
        '[router-selection] read-only should satisfy reviewer',
      );
      assert.deepEqual(
        filterNativeModels(['native-patch'], 'coder', modelRegistry, repoDir, NOW).eligible,
        ['native-patch'],
        '[router-selection] patch should satisfy coder',
      );
      assert.deepEqual(
        filterNativeModels(['native-workflow'], 'planner', modelRegistry, repoDir, NOW).eligible,
        ['native-workflow'],
        '[router-selection] workflow should satisfy planner',
      );

      const insufficient = filterNativeModels(['native-readonly', 'native-patch'], 'planner', modelRegistry, repoDir, NOW);
      assert.deepEqual(insufficient.eligible, [], '[router-selection] lower phases must not satisfy planner');
      expectNativeRejection(insufficient.rejected, 'native-readonly', 'planner', 'insufficient-phase');
      expectNativeRejection(insufficient.rejected, 'native-patch', 'planner', 'insufficient-phase');
    } finally {
      cleanup();
    }
  });

  it('[router-selection] fail-closed router rejects stale, missing, wrong-suite, malformed, and failed artifacts', () => {
    const nativeIds = ['native-stale', 'native-missing', 'native-wrong-suite', 'native-malformed', 'native-scenario-fail'];
    const { repoDir, cleanup } = makeRepo(Object.fromEntries(
      nativeIds.map((id) => [id, nativeModel('patch', id === 'native-wrong-suite' ? 'v2' : 'v1')]),
    ));
    try {
      writeCertArtifact(repoDir, 'openai', 'native-stale', 'v1', { certifiedAt: STALE_CERTIFIED_AT });
      writeCertArtifact(repoDir, 'openai', 'native-wrong-suite', 'v2', { suiteVersion: 'v1' });
      writeMalformedCert(repoDir, 'openai', 'native-malformed');
      writeCertArtifact(repoDir, 'openai', 'native-scenario-fail', 'v1', {
        scenarios: [{ scenarioId: 'rollout.failure', passed: false }],
      });

      const decision = routeWorkflow('Implement provider certification rollout regression tests.', {
        repoDir,
        coderModelsAvailable: [...nativeIds, NON_NATIVE_A],
        modelsAvailable: [...nativeIds, NON_NATIVE_A],
        skipDifficultyClassification: true,
      });

      assert.equal(decision.coder, NON_NATIVE_A, '[router-selection] router should select fallback when all native candidates fail closed');
      expectNativeRejection(decision.nativeCertificationRejections, 'native-stale', 'coder', 'stale');
      expectNativeRejection(decision.nativeCertificationRejections, 'native-missing', 'coder', 'missing');
      expectNativeRejection(decision.nativeCertificationRejections, 'native-wrong-suite', 'coder', 'wrong-suite');
      expectNativeRejection(decision.nativeCertificationRejections, 'native-malformed', 'coder', 'malformed');
      expectNativeRejection(decision.nativeCertificationRejections, 'native-scenario-fail', 'coder', 'insufficient-phase');
    } finally {
      cleanup();
    }
  });
});

describe('Epic 9 rollout regression: [harness] [artifact-validity] [retry] [command]', () => {
  it('[harness] [artifact-validity] validates passing and failing harness artifacts without provider calls', async () => {
    const report = await runScenarios({
      provider: 'openai',
      model: 'native-harness',
      transport: 'openai-responses',
      scenarios: [scenario('rollout.pass', [{ kind: 'pass' }])],
      retryPolicy: { maxAttempts: 1 },
    });
    assert.equal(report.harnessPassed, true, '[harness] passing synthetic scenario should pass');

    const artifact: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: 'openai',
      model: 'native-harness',
      phase: 'read-only',
      suiteVersion: 'v1',
      certifiedAt: FRESH_CERTIFIED_AT,
      scenarios: report.results.map(toArtifactScenario),
    };
    const valid = validateCertification(artifact, {
      expectedProvider: 'openai',
      expectedModel: 'native-harness',
      expectedSuiteVersion: 'v1',
      requiredPhase: 'read-only',
      now: NOW,
    });
    assert.equal(valid.ok, true, '[artifact-validity] passing harness rows should validate');

    const failingArtifact: NativeCertificationArtifact = {
      ...artifact,
      scenarios: [{ scenarioId: 'rollout.failed-row', passed: false }],
    };
    const invalid = validateCertification(failingArtifact, {
      expectedProvider: 'openai',
      expectedModel: 'native-harness',
      expectedSuiteVersion: 'v1',
      requiredPhase: 'read-only',
      now: NOW,
    });
    assert.equal(invalid.ok, false, '[artifact-validity] failed scenario rows must invalidate artifacts');
    assert.ok(
      !invalid.ok && invalid.errors.some((error) => error.code === 'scenario-failure'),
      '[artifact-validity] validation failure should identify scenario-failure',
    );
  });

  it('[retry] succeeds within bounds and fails closed when retries are exhausted', async () => {
    const transient = await runScenarios({
      provider: 'openai',
      model: 'native-retry',
      transport: 'openai-responses',
      scenarios: [scenario('rollout.flake-then-pass', [{ kind: 'provider-flake', detail: 'transient' }, { kind: 'pass' }])],
      retryPolicy: { maxAttempts: 2 },
    });
    assert.equal(transient.harnessPassed, true, '[retry] scenario should pass when retry bound reaches success');
    assert.equal(transient.results[0].attempts, 2, '[retry] retry count should be visible');

    const exhausted = await runScenarios({
      provider: 'openai',
      model: 'native-retry',
      transport: 'openai-responses',
      scenarios: [scenario('rollout.exhausted', [{ kind: 'provider-flake', detail: 'still flaky' }, { kind: 'pass' }])],
      retryPolicy: { maxAttempts: 1 },
    });
    assert.equal(exhausted.harnessPassed, false, '[retry] exhausted retry bound should fail closed');
    assert.equal(exhausted.results[0].failureClass, 'provider_flake', '[retry] output should identify provider flake');
  });

  it('[command] dry-run, live write, and harness failure command behavior is explicit', async () => {
    const modelRegistry = registry({ 'native-command': nativeModel('read-only') });
    let writes = 0;

    const dryRun = await certifyNativeAgent({
      provider: 'openai',
      model: 'native-command',
      phase: 'read-only',
      repoDir: '/repo',
      dryRun: true,
      registry: modelRegistry,
      runScenariosFn: async () => passingReport({ dryRun: true, liveCertifiable: false }),
      writeCertificationFn: () => {
        writes += 1;
        return '/repo/cert.json';
      },
    });
    assert.equal(writes, 0, '[command] dry-run must not write artifact');
    assert.equal(dryRun.dryRun, true, '[command] result should identify dry-run');
    assert.equal(dryRun.provider, 'openai', '[command] result should identify provider');
    assert.equal(dryRun.model, 'native-command', '[command] result should identify model');
    assert.equal(dryRun.phase, 'read-only', '[command] result should identify phase');
    assert.equal(dryRun.scenarios[0].scenarioId, 'rollout.pass', '[command] result should identify scenarios');

    let written: NativeCertificationArtifact | undefined;
    const live = await certifyNativeAgent({
      provider: 'openai',
      model: 'native-command',
      phase: 'read-only',
      repoDir: '/repo',
      registry: modelRegistry,
      runScenariosFn: async () => passingReport(),
      writeCertificationFn: (_repoDir, artifact) => {
        written = artifact;
        writes += 1;
        return '/repo/.wavemill/native-agent-certifications/openai/native-command/v1.json';
      },
      now: () => NOW,
    });
    assert.equal(writes, 1, '[command] live success should write exactly once');
    assert.ok(written, '[command] live write should receive artifact');
    assert.equal(live.artifactPath?.endsWith('/v1.json'), true, '[command] live result should expose artifact path');
    assert.equal(written?.suiteVersion, DEFAULT_CERTIFICATION_SUITE_VERSION, '[command] artifact should use default suite version');

    const failed = await certifyNativeAgent({
      provider: 'openai',
      model: 'native-command',
      phase: 'read-only',
      repoDir: '/repo',
      registry: modelRegistry,
      runScenariosFn: async () => passingReport({
        results: [{
          scenarioId: 'rollout.fail',
          category: 'tool',
          classification: 'deterministic',
          phase: 'read-only',
          status: 'fail',
          detail: 'deterministic failure',
          attempts: 1,
          finalAttemptStatus: 'fail',
          failureClass: 'deterministic_failure',
          durationMs: 1,
        }],
        countsByStatus: { pass: 0, fail: 1, unsupported: 0, 'not-run': 0 },
        harnessPassed: false,
        liveCertifiable: false,
      }),
      writeCertificationFn: () => {
        writes += 1;
        return '/repo/cert.json';
      },
    });
    assert.equal(writes, 1, '[command] harness failure must not write');
    assert.equal(failed.harnessPassed, false, '[command] result should identify harness failure');
    assert.equal(failed.scenarios[0].status, 'fail', '[command] result should expose failed scenario status');
  });
});

describe('Epic 9 rollout regression: [challenge-guardrail]', () => {
  it('[challenge-guardrail] excludes uncertified native coding models and preserves certified candidates', () => {
    const { repoDir, cleanup } = makeRepo({
      'native-certified': nativeModel('patch'),
      'native-uncertified': nativeModel('patch'),
    });
    try {
      writeCertArtifact(repoDir, 'openai', 'native-certified', 'v1', { phase: 'patch' });

      const result = pickChallengeModelsWithReason(
        [NON_NATIVE_A, 'native-certified', 'native-uncertified'],
        {
          pairId: 'HOK-2400-CG1',
          issueId: 'HOK-2400-CG1',
          slug: 'rollout-guardrail-certified',
          primaryModel: NON_NATIVE_A,
          repoDir,
          now: NOW,
          randomFn: () => 0,
        },
      );

      assert.ok(result.pair, '[challenge-guardrail] challenge pair should still form with certified native candidate');
      assert.equal(result.pair.challenger.model, 'native-certified', '[challenge-guardrail] certified native challenger should remain eligible');
      expectNativeRejection(result.nativeCertificationRejections, 'native-uncertified', 'coder', 'missing');
    } finally {
      cleanup();
    }
  });

  it('[challenge-guardrail] forced uncertified native primary and challenger fall back to eligible models', () => {
    const { repoDir, cleanup } = makeRepo({ 'native-uncertified': nativeModel('patch') });
    try {
      const forcedPrimary = pickChallengeModelsWithReason(
        [NON_NATIVE_A, NON_NATIVE_B, 'native-uncertified'],
        {
          pairId: 'HOK-2400-CG2',
          issueId: 'HOK-2400-CG2',
          slug: 'rollout-guardrail-primary',
          primaryModel: 'native-uncertified',
          repoDir,
          now: NOW,
          randomFn: () => 0,
        },
      );
      assert.ok(forcedPrimary.pair, '[challenge-guardrail] fallback should form pair when primary is uncertified native');
      assert.notEqual(forcedPrimary.pair.primary.model, 'native-uncertified', '[challenge-guardrail] uncertified native primary must not be selected');
      expectNativeRejection(forcedPrimary.nativeCertificationRejections, 'native-uncertified', 'coder', 'missing');

      const forcedChallenger = pickChallengeModelsWithReason(
        [NON_NATIVE_A, NON_NATIVE_B, 'native-uncertified'],
        {
          pairId: 'HOK-2400-CG3',
          issueId: 'HOK-2400-CG3',
          slug: 'rollout-guardrail-challenger',
          primaryModel: NON_NATIVE_A,
          forcedChallengerModel: 'native-uncertified',
          repoDir,
          now: NOW,
          randomFn: () => 0,
        },
      );
      assert.ok(forcedChallenger.pair, '[challenge-guardrail] fallback should form pair when challenger is uncertified native');
      assert.notEqual(forcedChallenger.pair.challenger.model, 'native-uncertified', '[challenge-guardrail] uncertified native challenger must not be selected');
      expectNativeRejection(forcedChallenger.nativeCertificationRejections, 'native-uncertified', 'coder', 'missing');
    } finally {
      cleanup();
    }
  });

  it('[challenge-guardrail] records stale native workflow rejections during challenge workflow selection', () => {
    const { repoDir, cleanup } = makeRepo({
      'native-stale-workflow': nativeModel('workflow'),
      'native-workflow': nativeModel('workflow'),
    });
    try {
      writeCertArtifact(repoDir, 'openai', 'native-stale-workflow', 'v1', {
        phase: 'workflow',
        certifiedAt: STALE_CERTIFIED_AT,
      });
      writeCertArtifact(repoDir, 'openai', 'native-workflow', 'v1', { phase: 'workflow' });

      const routeFn = (): WorkflowRouteDecision => ({
        planner: 'native-workflow',
        coder: NON_NATIVE_A,
        reviewer: NON_NATIVE_B,
        planDepth: 'medium',
        codeDepth: 'medium',
        reviewRecommended: 'llm',
        expectedSuccess: 0.9,
        expectedCostPlan: 1,
        expectedCostCode: 1,
        expectedCostReview: 1,
        reasoning: [],
        signals: {},
      });

      const result = pickChallengeWorkflowsWithReason(
        ['native-stale-workflow', 'native-workflow', NON_NATIVE_A],
        {
          pairId: 'HOK-2400-CG4',
          issueId: 'HOK-2400-CG4',
          slug: 'rollout-guardrail-workflow',
          prompt: 'Plan rollout regression certification.',
          challengeStage: 'plan',
          primaryModel: 'native-workflow',
          repoDir,
          now: NOW,
          randomFn: () => 0,
          routeFn,
        },
      );

      assert.ok(result.pair, '[challenge-guardrail] certified workflow native should remain eligible');
      expectNativeRejection(result.nativeCertificationRejections, 'native-stale-workflow', 'planner', 'stale');
    } finally {
      cleanup();
    }
  });
});

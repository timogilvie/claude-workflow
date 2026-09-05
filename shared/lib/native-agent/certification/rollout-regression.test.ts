import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from '../../config.ts';
import {
  assertRegistryConsistency,
  evaluateRegistryPhaseEligibility,
  ModelValidationError,
  computeIdentityFingerprint,
  validateNativeCapability,
  type ModelCapabilities,
  type ModelRegistry,
  type NativeCertificationMetadata,
} from '../../model-registry.ts';
import { pickChallengeModelsWithReason } from '../../challenge-mode.ts';
import { certifyNativeAgent } from '../../../../tools/native-agent-certify.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  getPatchCodingCertificationPath,
} from '../coding-certification.ts';
import { PATCH_CODING_SMOKE_SUITE_REVISION } from '../smoke.ts';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';
import { buildGlobalCertificationPath } from './loader.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './storage.ts';
import { buildLiveCodingCanaryFixture } from './canary-fixtures.ts';
import {
  filterNativeModels,
  runScenarios,
  toArtifactScenario,
  validateCertification,
  type HarnessReport,
  type RunScenariosOptions,
} from './index.ts';
import type {
  CertificationScenario,
  ScenarioAssertionOutcome,
  ScenarioContext,
} from './scenarios.ts';

const NOW = new Date('2026-06-30T00:00:00.000Z');
const FRESH_CERTIFIED_AT = '2026-06-01T00:00:00.000Z';
// Within the live-canary TTL (14 days) of NOW.
const CANARY_RAN_AT = '2026-06-25T00:00:00.000Z';
const STALE_CERTIFIED_AT = '2026-01-01T00:00:00.000Z';
const SUITE_VERSION = 'v-rollout';
const FIXTURE_DIR = new URL('./fixtures', import.meta.url).pathname;

function makeRepo(
  _modelRegistryModels: Record<string, Partial<ModelCapabilities>> = {},
  options: { patchCodingEnabled?: boolean } = {},
): {
  repoDir: string;
  cleanup: () => void;
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'rollout-regression-'));
  const previousGlobalRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = join(repoDir, 'global-certifications');
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    ...(options.patchCodingEnabled
      ? { nativeAgent: { patchCoding: { enabled: true } } }
      : {}),
  }));
  // The native coding launcher lives in the wavemill installation, not in the
  // repo under test, so there is nothing repo-local to stage here.
  clearConfigCache(repoDir);

  return {
    repoDir,
    cleanup: () => {
      if (previousGlobalRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousGlobalRoot;
      }
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function writePatchCodingCertification(repoDir: string): void {
  const certificationPath = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(certificationPath), { recursive: true });
  writeFileSync(certificationPath, JSON.stringify({
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    certifiedAt: FRESH_CERTIFIED_AT,
    providers: [
      { provider: 'openai', model: 'native-certified', passed: true },
      { provider: 'openrouter', model: 'openai/native-certified', passed: true },
    ],
  }));
}

function nativeCertificationMetadata(
  overrides: Partial<NativeCertificationMetadata> = {},
): NativeCertificationMetadata {
  return {
    maxCertifiedPhase: 'patch',
    certifiedAt: FRESH_CERTIFIED_AT,
    certificationSuiteVersion: SUITE_VERSION,
    ...overrides,
  };
}

function modelCapabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    vendor: 'openai',
    class: 'strong_generalist',
    strengths: ['coding'],
    weaknesses: [],
    qualityScores: { routing: 70, planning: 75, coding: 85, review: 80, classify: 70 },
    contextWindowTokens: 128_000,
    toolSupport: 'full',
    multimodal: { text: true, image: false },
    latencyTier: 'standard',
    reasoningTier: 'standard',
    costPerMillionInputTokensUsd: 1,
    costPerMillionOutputTokensUsd: 4,
    ...overrides,
  };
}

function nativeModel(
  phase: CertificationPhase = 'patch',
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  return modelCapabilities({
    nativeCapability: {
      nativeProvider: 'openai',
      piTransportKind: 'openai-responses',
      readOnlyNative: 'certified',
      certification: nativeCertificationMetadata({ maxCertifiedPhase: phase }),
    },
    ...overrides,
  });
}

function registryWith(models: Record<string, ModelCapabilities>): ModelRegistry {
  return { models, ladders: {} };
}

function writeCertArtifact(
  _repoDir: string,
  provider: string,
  model: string,
  suiteVersion = SUITE_VERSION,
  overrides: Partial<NativeCertificationArtifact> = {},
): string {
  const artifactPath = buildGlobalCertificationPath(provider, model, suiteVersion);
  mkdirSync(dirname(artifactPath), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: testSubject(provider, model),
    provider,
    model,
    phase: 'patch',
    suiteVersion,
    certifiedAt: FRESH_CERTIFIED_AT,
    scenarios: [{ scenarioId: 'rollout.synthetic.pass', passed: true }],
    // Coding-capable phases carry an eligible live canary by default so
    // coder-positive rollout cases stay valid under the HOK-2943 gate;
    // negative canary cases override liveCanary explicitly.
    ...((overrides.phase ?? 'patch') !== 'read-only'
      ? { liveCanary: buildLiveCodingCanaryFixture(testSubject(provider, model), suiteVersion, { ranAt: CANARY_RAN_AT }) }
      : {}),
    ...overrides,
  };
  writeFileSync(artifactPath, JSON.stringify(artifact));
  return artifactPath;
}

function testSubject(provider: string, model: string): NativeCertificationArtifact['subject'] {
  return {
    registryKey: model,
    nativeProvider: provider,
    providerId: provider,
    providerModelId: model,
    providerNativeId: model,
    identityRevision: 1,
    identityFingerprint: computeIdentityFingerprint({
      alias: model,
      providerNativeId: model,
      provider,
      revision: 1,
    }),
    catalogHash: 'registry',
  };
}

function writeMalformedArtifact(
  _repoDir: string,
  provider: string,
  model: string,
  suiteVersion = SUITE_VERSION,
): void {
  const artifactPath = buildGlobalCertificationPath(provider, model, suiteVersion);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, '{"schemaVersion":');
}

function scenario(
  id: string,
  outcome: ScenarioAssertionOutcome | ((ctx: ScenarioContext) => Promise<ScenarioAssertionOutcome>),
): CertificationScenario {
  return {
    id,
    phase: 'read-only',
    category: 'tool',
    classification: 'deterministic',
    description: `Synthetic rollout regression scenario: ${id}`,
    assertion: typeof outcome === 'function'
      ? outcome
      : async () => outcome,
  };
}

function fixture(name: string): NativeCertificationArtifact {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as NativeCertificationArtifact;
  return {
    ...raw,
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: testSubject(raw.provider, raw.model),
  };
}

function assertModelValidationMessage(fn: () => void, pattern: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof ModelValidationError);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe('[registry-metadata] rollout native certification metadata', () => {
  it('[registry-metadata] accepts complete certification metadata and evaluates phase eligibility', () => {
    const registry = registryWith({
      'native-certified': nativeModel('patch', {
        nativeCapability: {
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          compatFlags: { thinkingFormat: 'openrouter', futureFlagIgnoredByDerivation: true },
          readOnlyNative: 'certified',
          certification: nativeCertificationMetadata({
            maxCertifiedPhase: 'patch',
            knownLimitations: ['dry-run synthetic only'],
          }),
        },
      }),
    });

    assert.doesNotThrow(() => validateNativeCapability('native-certified', registry.models['native-certified']));
    assert.doesNotThrow(() => assertRegistryConsistency(registry));
    assert.deepEqual(
      evaluateRegistryPhaseEligibility({
        modelId: 'native-certified',
        phase: 'patch',
        registry,
        now: NOW,
      }),
      {
        eligible: true,
        modelId: 'native-certified',
        phase: 'patch',
        certifiedAt: FRESH_CERTIFIED_AT,
        suiteVersion: SUITE_VERSION,
      },
    );
  });

  it('[registry-metadata] rejects missing and malformed required certification metadata with explicit fields', () => {
    assertModelValidationMessage(
      () => validateNativeCapability('native-missing-provider', {
        nativeCapability: {
          readOnlyNative: 'certified',
          piTransportKind: 'openai-responses',
          certification: nativeCertificationMetadata(),
        } as any,
      }),
      /nativeProvider/,
    );
    assertModelValidationMessage(
      () => validateNativeCapability('native-bad-phase', {
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
          certification: nativeCertificationMetadata({ maxCertifiedPhase: 'not-a-phase' as CertificationPhase }),
        },
      }),
      /maxCertifiedPhase/,
    );
    assertModelValidationMessage(
      () => validateNativeCapability('native-unsafe-suite', {
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
          certification: nativeCertificationMetadata({ certificationSuiteVersion: '../v1' }),
        },
      }),
      /certificationSuiteVersion/,
    );

    assert.deepEqual(
      evaluateRegistryPhaseEligibility({
        modelId: 'native-no-metadata',
        phase: 'read-only',
        registry: registryWith({
          'native-no-metadata': modelCapabilities({
            nativeCapability: {
              nativeProvider: 'openai',
              piTransportKind: 'openai-responses',
              readOnlyNative: 'certified',
            },
          }),
        }),
        now: NOW,
      }),
      {
        eligible: false,
        modelId: 'native-no-metadata',
        phase: 'read-only',
        reason: 'no-metadata',
      },
    );
  });
});

describe('[router-policy] rollout native router phase and fail-closed policy', () => {
  it('[router-policy] admits eligible phase and excludes insufficient phase while preserving diagnostics', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeCertArtifact(repoDir, 'openai', 'native-patch');
      writeCertArtifact(repoDir, 'openai', 'native-readonly', SUITE_VERSION, { phase: 'read-only' });
      const registry = registryWith({
        'native-patch': nativeModel('patch'),
        'native-readonly': nativeModel('read-only'),
        'non-native': modelCapabilities({ vendor: 'anthropic' }),
      });

      const result = filterNativeModels(
        ['native-patch', 'native-readonly', 'non-native'],
        'coder',
        registry,
        repoDir,
        NOW,
      );

      assert.deepEqual(result.eligible, ['native-patch', 'non-native']);
      assert.equal(result.rejected.length, 1);
      assert.deepEqual(
        { ...result.rejected[0], artifactPath: undefined },
        {
          modelId: 'native-readonly',
          role: 'coder',
          requestedLaunchPhase: 'coding',
          requestedPhase: 'patch',
          certifiedPhase: 'read-only',
          nativeCapability: 'certified',
          nativeProvider: 'openai',
          requiredSuiteVersion: SUITE_VERSION,
          reason: 'insufficient-phase',
          artifactPath: undefined,
        },
      );
    } finally {
      cleanup();
    }
  });

  it('[router-policy] fail-closes stale, missing, wrong-suite, malformed, and scenario-failed artifacts', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeCertArtifact(repoDir, 'openai', 'native-stale', SUITE_VERSION, { certifiedAt: STALE_CERTIFIED_AT });
      writeCertArtifact(repoDir, 'openai', 'native-wrong-suite', SUITE_VERSION, { suiteVersion: 'different-suite' });
      writeMalformedArtifact(repoDir, 'openai', 'native-malformed');
      writeCertArtifact(repoDir, 'openai', 'native-scenario-failure', SUITE_VERSION, {
        scenarios: [{ scenarioId: 'rollout.synthetic.fail', passed: false }],
      });
      const registry = registryWith({
        'native-stale': nativeModel('patch'),
        'native-missing': nativeModel('patch'),
        'native-wrong-suite': nativeModel('patch'),
        'native-malformed': nativeModel('patch'),
        'native-scenario-failure': nativeModel('patch'),
      });

      const result = filterNativeModels(
        Object.keys(registry.models),
        'coder',
        registry,
        repoDir,
        NOW,
      );
      const reasons = Object.fromEntries(result.rejected.map((rejection) => [rejection.modelId, rejection.reason]));

      assert.deepEqual(result.eligible, []);
      assert.deepEqual(reasons, {
        'native-stale': 'stale',
        'native-missing': 'missing-artifact',
        'native-wrong-suite': 'wrong-suite',
        'native-malformed': 'malformed',
        'native-scenario-failure': 'insufficient-phase',
      });
      for (const rejection of result.rejected) {
        assert.equal(rejection.role, 'coder');
        assert.equal(rejection.requestedPhase, 'patch');
        assert.equal(rejection.nativeCapability, 'certified');
        assert.equal(rejection.requiredSuiteVersion, SUITE_VERSION);
      }
    } finally {
      cleanup();
    }
  });
});

describe('[dry-run-certification] rollout harness, artifacts, and retry behavior', () => {
  it('[dry-run-certification] reports pass, fail, provider-flake retry, and dry-run non-certifiability', async () => {
    let flakyAttempts = 0;
    const report = await runScenarios({
      provider: 'openai',
      model: 'native-dry-run',
      transport: 'openai-responses',
      dryRun: true,
      retryPolicy: { maxAttempts: 2 },
      now: (() => {
        let tick = 0;
        return () => tick++;
      })(),
      scenarios: [
        scenario('rollout.pass', { kind: 'pass' }),
        scenario('rollout.fail', { kind: 'fail', detail: 'artifact validity: deterministic failure' }),
        scenario('rollout.flake', async () => {
          flakyAttempts += 1;
          return flakyAttempts === 1
            ? { kind: 'provider-flake', detail: 'transient provider error' }
            : { kind: 'pass' };
        }),
      ],
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.liveCertifiable, false);
    assert.equal(report.harnessPassed, false);
    assert.equal(report.countsByStatus.pass, 2);
    assert.equal(report.countsByStatus.fail, 1);
    assert.equal(report.results.find((result) => result.scenarioId === 'rollout.flake')?.attempts, 2);
    assert.deepEqual(
      report.results.map(toArtifactScenario),
      [
        { scenarioId: 'rollout.pass', passed: true, attempts: 1, retryCount: 0, finalAttemptStatus: 'pass' },
        {
          scenarioId: 'rollout.fail',
          passed: false,
          attempts: 1,
          retryCount: 0,
          finalAttemptStatus: 'fail',
          failureClass: 'deterministic_failure',
          failureMessage: 'artifact validity: deterministic failure',
        },
        { scenarioId: 'rollout.flake', passed: true, attempts: 2, retryCount: 1, finalAttemptStatus: 'pass' },
      ],
    );
  });

  it('[dry-run-certification] validates valid and invalid fixture artifacts with attributable errors', () => {
    const valid = fixture('valid-patch.json');
    const validResult = validateCertification(valid, {
      expectedProvider: valid.provider,
      expectedModel: valid.model,
      expectedSuiteVersion: valid.suiteVersion,
      requiredPhase: 'patch',
      now: NOW,
    });
    assert.equal(validResult.ok, true);

    const invalid = fixture('scenario-failure.json');
    const invalidResult = validateCertification(invalid, {
      expectedProvider: invalid.provider,
      expectedModel: invalid.model,
      expectedSuiteVersion: invalid.suiteVersion,
      requiredPhase: 'read-only',
      now: NOW,
    });
    assert.equal(invalidResult.ok, false);
    if (!invalidResult.ok) {
      assert.ok(
        invalidResult.errors.some((error) => error.code === 'scenario-failure'),
        `artifact validity diagnostics should include scenario-failure: ${JSON.stringify(invalidResult.errors)}`,
      );
    }
  });
});

describe('[challenge-guardrails] rollout challenge-mode native candidate filtering', () => {
  it('[challenge-guardrails] rejects uncertified and stale native coding models through repoDir guardrails', () => {
    const { repoDir, cleanup } = makeRepo({
      'native-certified': nativeModel('patch'),
      'native-uncertified': nativeModel('patch'),
      'native-stale': nativeModel('patch'),
    }, {
      patchCodingEnabled: true,
    });
    try {
      writePatchCodingCertification(repoDir);
      writeCertArtifact(repoDir, 'openai', 'native-certified');
      writeCertArtifact(repoDir, 'openai', 'native-stale', SUITE_VERSION, { certifiedAt: STALE_CERTIFIED_AT });

      const result = pickChallengeModelsWithReason(
        ['claude-opus-4-6', 'claude-sonnet-4-6', 'native-certified', 'native-uncertified', 'native-stale'],
        {
          pairId: 'rollout-guardrails',
          issueId: 'HOK-2400',
          slug: 'rollout-guardrails',
          primaryModel: 'claude-opus-4-6',
          repoDir,
          now: NOW,
          randomFn: () => 0,
        },
      );

      assert.ok(result.pair, 'global non-native fallback should form a challenge pair');
      assert.equal(result.pair.challenger.model, 'claude-sonnet-4-6');
      const reasons = Object.fromEntries(
        (result.nativeCertificationRejections ?? []).map((rejection) => [rejection.modelId, rejection.reason]),
      );
      assert.deepEqual(reasons, {
        'native-certified': 'no-native-capability',
        'native-uncertified': 'no-native-capability',
        'native-stale': 'no-native-capability',
      });
    } finally {
      cleanup();
    }
  });

  it('[challenge-guardrails] blocks forced uncertified native challenger but still selects a non-native fallback', () => {
    const { repoDir, cleanup } = makeRepo({
      'native-uncertified': nativeModel('patch'),
    });
    try {
      const result = pickChallengeModelsWithReason(
        ['claude-opus-4-6', 'claude-sonnet-4-6', 'native-uncertified'],
        {
          pairId: 'rollout-forced-guardrail',
          issueId: 'HOK-2400',
          slug: 'rollout-forced-guardrail',
          primaryModel: 'claude-opus-4-6',
          forcedChallengerModel: 'native-uncertified',
          repoDir,
          now: NOW,
          randomFn: () => 0,
        },
      );

      assert.ok(result.pair, 'non-native fallback should keep challenge selection viable');
      assert.equal(result.pair.challenger.model, 'claude-sonnet-4-6');
      const rejection = (result.nativeCertificationRejections ?? []).find(
        (entry) => entry.modelId === 'native-uncertified',
      );
      assert.ok(rejection, 'challenge guardrail should report the uncertified native model');
      assert.equal(rejection.reason, 'no-native-capability');
      assert.equal(rejection.role, 'coder');
    } finally {
      cleanup();
    }
  });
});

describe('[certification-command] rollout dry-run command behavior', () => {
  it('[certification-command] dry-run injects harness and never writes a live artifact', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let writeCalls = 0;
      let receivedOptions: RunScenariosOptions | undefined;
      const registry = registryWith({ 'native-command': nativeModel('patch') });
      const result = await certifyNativeAgent({
        provider: 'openai',
        model: 'native-command',
        phase: 'patch',
        repoDir,
        dryRun: true,
        registry,
        runScenariosFn: async (opts: RunScenariosOptions): Promise<HarnessReport> => {
          receivedOptions = opts;
          return {
            provider: opts.provider,
            model: opts.model,
            transport: opts.transport,
            dryRun: true,
            liveCertifiable: false,
            harnessPassed: true,
            knownLimitations: [],
            results: [{
              scenarioId: 'rollout.command.pass',
              category: 'tool',
              classification: 'deterministic',
              phase: 'patch',
              status: 'pass',
              attempts: 1,
              finalAttemptStatus: 'pass',
              durationMs: 0,
            }],
            countsByStatus: { pass: 1, fail: 0, unsupported: 0, 'not-run': 0 },
            countsByCategory: { tool: 1, usage: 0, transcript: 0, phase: 0 },
          };
        },
        writeCertificationFn: () => {
          writeCalls += 1;
          throw new Error('certification command behavior: dry-run attempted to write an artifact');
        },
      });

      assert.equal(writeCalls, 0);
      assert.equal(receivedOptions?.dryRun, true);
      assert.equal(receivedOptions?.provider, 'openai');
      assert.equal(receivedOptions?.model, 'native-command');
      assert.equal(receivedOptions?.transport, 'openai-responses');
      assert.equal(result.dryRun, true);
      assert.equal(result.harnessPassed, true);
      assert.equal(result.liveCertifiable, false);
      assert.equal(result.artifactPath, undefined);
      assert.deepEqual(result.scenarios, [{ scenarioId: 'rollout.command.pass', status: 'pass' }]);
    } finally {
      cleanup();
    }
  });

  it('[certification-command] unsupported models fail before harness or provider execution', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      let harnessCalls = 0;
      await assert.rejects(
        certifyNativeAgent({
          provider: 'openai',
          model: 'native-unsupported',
          phase: 'read-only',
          repoDir,
          dryRun: true,
          registry: registryWith({
            'native-unsupported': modelCapabilities({
              nativeCapability: {
                nativeProvider: 'openai',
                piTransportKind: 'openai-responses',
                readOnlyNative: 'unsupported',
              },
            }),
          }),
          runScenariosFn: async () => {
            harnessCalls += 1;
            throw new Error('certification command behavior: live provider path was invoked');
          },
        }),
        /not supported for native certification/,
      );
      assert.equal(harnessCalls, 0);
    } finally {
      cleanup();
    }
  });
});

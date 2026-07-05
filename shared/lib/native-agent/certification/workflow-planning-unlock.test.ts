import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from '../../config.ts';
import type { ModelCapabilities, ModelRegistry } from '../../model-registry.ts';
import {
  buildCertificationPath,
  buildModelCertificationReport,
  CERTIFICATION_SCHEMA_VERSION,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  filterNativeModels,
  serializeReport,
  writeCertification,
  type NativeCertificationArtifact,
} from './index.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-30T00:00:00.000Z');
const FRESH_CERTIFIED_AT = '2026-06-01T00:00:00.000Z';
const STALE_CERTIFIED_AT = '2026-01-01T00:00:00.000Z';
const SUITE_VERSION = DEFAULT_CERTIFICATION_SUITE_VERSION;

/**
 * Raw OpenRouter IDs from the acceptance criteria and their safe single-segment
 * equivalents for the storage path contract.
 *
 * Raw IDs contain `/` which is rejected by buildCertificationPath.
 */
const TARGET_MODELS = [
  { raw: 'qwen/qwen3-coder', safe: 'qwen-3-coder' },
  { raw: 'z-ai/glm-5.2', safe: 'z-ai-glm-5.2' },
  { raw: 'moonshotai/kimi-k2.7-code', safe: 'kimi-k2.7-code' },
] as const;

const SAFE_MODEL_IDS = TARGET_MODELS.map(m => m.safe);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(modelRegistryModels: Record<string, Partial<ModelCapabilities>> = {}): {
  repoDir: string;
  cleanup: () => void;
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'wf-plan-unlock-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    modelRegistry: { models: modelRegistryModels },
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

function modelCapabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    vendor: 'openrouter',
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

function openrouterNativeModel(
  safeId: string,
  phase: 'read-only' | 'patch' | 'workflow' = 'workflow',
  certOverrides: Record<string, unknown> = {},
): ModelCapabilities {
  return modelCapabilities({
    nativeCapability: {
      nativeProvider: 'openrouter',
      piTransportKind: 'openai-completions',
      compatFlags: { thinkingFormat: 'openrouter' },
      readOnlyNative: 'certified',
      certification: {
        maxCertifiedPhase: phase,
        certifiedAt: FRESH_CERTIFIED_AT,
        certificationSuiteVersion: SUITE_VERSION,
        ...certOverrides,
      },
    },
  });
}

function registryWith(models: Record<string, ModelCapabilities>): ModelRegistry {
  return { models, ladders: {} };
}

function workflowArtifact(
  safeModel: string,
  overrides: Partial<NativeCertificationArtifact> = {},
): NativeCertificationArtifact {
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: 'openrouter',
    model: safeModel,
    phase: 'workflow',
    suiteVersion: SUITE_VERSION,
    certifiedAt: FRESH_CERTIFIED_AT,
    scenarios: [
      { scenarioId: 'workflow.synthetic.planning', passed: true },
      { scenarioId: 'workflow.synthetic.orchestration', passed: true },
    ],
    ...overrides,
  };
}

function writeWorkflowArtifactsForAllModels(repoDir: string): string[] {
  return SAFE_MODEL_IDS.map(safeId => {
    return writeCertification(repoDir, workflowArtifact(safeId));
  });
}

function buildTestRegistry(): ModelRegistry {
  const models: Record<string, ModelCapabilities> = {};
  for (const safeId of SAFE_MODEL_IDS) {
    models[safeId] = openrouterNativeModel(safeId);
  }
  return registryWith(models);
}

// ---------------------------------------------------------------------------
// Phase 2 & 3: Artifact creation and storage path verification
// ---------------------------------------------------------------------------

describe('[workflow-planning-unlock] certification artifact creation and storage', () => {
  it('writes workflow artifacts at the expected path contract for all three target models', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const paths = writeWorkflowArtifactsForAllModels(repoDir);

      for (let i = 0; i < TARGET_MODELS.length; i++) {
        const { safe } = TARGET_MODELS[i];
        const expected = buildCertificationPath(repoDir, 'openrouter', safe, SUITE_VERSION);
        assert.equal(
          paths[i],
          expected,
          `artifact path for ${safe} should match storage contract`,
        );
        assert.ok(
          paths[i].includes(`.wavemill/native-agent-certifications/openrouter/${safe}/${SUITE_VERSION}.json`),
          `path should contain the expected directory structure`,
        );
      }
    } finally {
      cleanup();
    }
  });

  it('written artifacts contain correct provider, model, phase, and suite fields', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const paths = writeWorkflowArtifactsForAllModels(repoDir);

      for (let i = 0; i < TARGET_MODELS.length; i++) {
        const { safe } = TARGET_MODELS[i];
        const raw = JSON.parse(readFileSync(paths[i], 'utf-8'));
        assert.equal(raw.provider, 'openrouter');
        assert.equal(raw.model, safe);
        assert.equal(raw.phase, 'workflow');
        assert.equal(raw.suiteVersion, SUITE_VERSION);
        assert.equal(raw.schemaVersion, CERTIFICATION_SCHEMA_VERSION);
        assert.ok(raw.scenarios.length > 0, 'artifact should have scenarios');
        assert.ok(raw.scenarios.every((s: { passed: boolean }) => s.passed), 'all scenarios should pass');
      }
    } finally {
      cleanup();
    }
  });

  it('raw OpenRouter model IDs with slashes are rejected by buildCertificationPath', () => {
    for (const { raw } of TARGET_MODELS) {
      assert.throws(
        () => buildCertificationPath('/tmp/test-repo', 'openrouter', raw, SUITE_VERSION),
        /Invalid certification path segment/,
        `raw ID "${raw}" should be rejected`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Planner and reviewer eligibility
// ---------------------------------------------------------------------------

describe('[workflow-planning-unlock] planner and reviewer eligibility from workflow certification', () => {
  it('workflow-certified models are eligible for planner role', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeWorkflowArtifactsForAllModels(repoDir);
      const registry = buildTestRegistry();

      const result = filterNativeModels(SAFE_MODEL_IDS, 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, [...SAFE_MODEL_IDS]);
      assert.deepEqual(result.rejected, []);
    } finally {
      cleanup();
    }
  });

  it('workflow-certified models are eligible for reviewer role (downward inheritance)', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeWorkflowArtifactsForAllModels(repoDir);
      const registry = buildTestRegistry();

      const result = filterNativeModels(SAFE_MODEL_IDS, 'reviewer', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, [...SAFE_MODEL_IDS]);
      assert.deepEqual(result.rejected, []);
    } finally {
      cleanup();
    }
  });

  it('workflow-certified models are eligible for coder role (downward inheritance)', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeWorkflowArtifactsForAllModels(repoDir);
      const registry = buildTestRegistry();

      const result = filterNativeModels(SAFE_MODEL_IDS, 'coder', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, [...SAFE_MODEL_IDS]);
      assert.deepEqual(result.rejected, []);
    } finally {
      cleanup();
    }
  });

  it('read-only certified model is eligible for reviewer but rejected for planner with insufficient-phase', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const readOnlyModel = 'readonly-native';
      writeCertification(repoDir, {
        schemaVersion: CERTIFICATION_SCHEMA_VERSION,
        provider: 'openrouter',
        model: readOnlyModel,
        phase: 'read-only',
        suiteVersion: SUITE_VERSION,
        certifiedAt: FRESH_CERTIFIED_AT,
        scenarios: [{ scenarioId: 'readonly.synthetic', passed: true }],
      });
      const registry = registryWith({
        [readOnlyModel]: openrouterNativeModel(readOnlyModel, 'read-only'),
      });

      const reviewerResult = filterNativeModels([readOnlyModel], 'reviewer', registry, repoDir, NOW);
      assert.deepEqual(reviewerResult.eligible, [readOnlyModel]);

      const plannerResult = filterNativeModels([readOnlyModel], 'planner', registry, repoDir, NOW);
      assert.deepEqual(plannerResult.eligible, []);
      assert.equal(plannerResult.rejected.length, 1);
      assert.equal(plannerResult.rejected[0].reason, 'insufficient-phase');
      assert.equal(plannerResult.rejected[0].certifiedPhase, 'read-only');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Invalid artifact rejection matrix
// ---------------------------------------------------------------------------

describe('[workflow-planning-unlock] invalid artifact rejection matrix', () => {
  const testModel = SAFE_MODEL_IDS[0]; // qwen-3-coder

  it('rejects missing artifact with reason "missing"', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const registry = registryWith({
        [testModel]: openrouterNativeModel(testModel),
      });

      const result = filterNativeModels([testModel], 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, 'missing');
      assert.equal(result.rejected[0].modelId, testModel);
      assert.equal(result.rejected[0].role, 'planner');
      assert.equal(result.rejected[0].requestedPhase, 'workflow');
      assert.equal(result.rejected[0].nativeCapability, 'certified');
      assert.equal(result.rejected[0].requiredSuiteVersion, SUITE_VERSION);
    } finally {
      cleanup();
    }
  });

  it('rejects stale artifact with reason "stale"', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeCertification(repoDir, workflowArtifact(testModel, {
        certifiedAt: STALE_CERTIFIED_AT,
      }));
      const registry = registryWith({
        [testModel]: openrouterNativeModel(testModel),
      });

      const result = filterNativeModels([testModel], 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, 'stale');
      assert.equal(result.rejected[0].modelId, testModel);
      assert.equal(result.rejected[0].role, 'planner');
      assert.equal(result.rejected[0].requestedPhase, 'workflow');
    } finally {
      cleanup();
    }
  });

  it('rejects malformed (invalid JSON) artifact with reason "malformed"', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const certDir = join(
        repoDir,
        '.wavemill/native-agent-certifications/openrouter',
        testModel,
      );
      mkdirSync(certDir, { recursive: true });
      writeFileSync(join(certDir, `${SUITE_VERSION}.json`), '{"schemaVersion":');

      const registry = registryWith({
        [testModel]: openrouterNativeModel(testModel),
      });

      const result = filterNativeModels([testModel], 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, 'malformed');
      assert.equal(result.rejected[0].modelId, testModel);
    } finally {
      cleanup();
    }
  });

  it('rejects schema-invalid JSON artifact with reason "malformed"', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      const certDir = join(
        repoDir,
        '.wavemill/native-agent-certifications/openrouter',
        testModel,
      );
      mkdirSync(certDir, { recursive: true });
      writeFileSync(
        join(certDir, `${SUITE_VERSION}.json`),
        JSON.stringify({ schemaVersion: 999, provider: 'openrouter', model: testModel }),
      );

      const registry = registryWith({
        [testModel]: openrouterNativeModel(testModel),
      });

      const result = filterNativeModels([testModel], 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, 'malformed');
    } finally {
      cleanup();
    }
  });

  it('rejects wrong-suite artifact with reason "wrong-suite"', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      // Write artifact at the path the filter will look up (SUITE_VERSION) but
      // with a mismatched suiteVersion field inside the artifact. We must write
      // directly because writeCertification derives the path from
      // record.suiteVersion — which would put the file in the wrong location.
      const artifact = workflowArtifact(testModel, { suiteVersion: 'v-wrong' });
      const certDir = join(
        repoDir,
        '.wavemill/native-agent-certifications/openrouter',
        testModel,
      );
      mkdirSync(certDir, { recursive: true });
      writeFileSync(join(certDir, `${SUITE_VERSION}.json`), JSON.stringify(artifact));

      const registry = registryWith({
        [testModel]: openrouterNativeModel(testModel),
      });

      const result = filterNativeModels([testModel], 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, 'wrong-suite');
      assert.equal(result.rejected[0].modelId, testModel);
      assert.equal(result.rejected[0].role, 'planner');
    } finally {
      cleanup();
    }
  });

  it('rejects insufficient-phase artifact with reason "insufficient-phase"', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeCertification(repoDir, {
        schemaVersion: CERTIFICATION_SCHEMA_VERSION,
        provider: 'openrouter',
        model: testModel,
        phase: 'read-only',
        suiteVersion: SUITE_VERSION,
        certifiedAt: FRESH_CERTIFIED_AT,
        scenarios: [{ scenarioId: 'readonly.synthetic', passed: true }],
      });
      const registry = registryWith({
        [testModel]: openrouterNativeModel(testModel),
      });

      const result = filterNativeModels([testModel], 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, 'insufficient-phase');
      assert.equal(result.rejected[0].certifiedPhase, 'read-only');
      assert.equal(result.rejected[0].requestedPhase, 'workflow');
    } finally {
      cleanup();
    }
  });

  it('rejects patch-phase artifact for planner with reason "insufficient-phase"', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeCertification(repoDir, {
        schemaVersion: CERTIFICATION_SCHEMA_VERSION,
        provider: 'openrouter',
        model: testModel,
        phase: 'patch',
        suiteVersion: SUITE_VERSION,
        certifiedAt: FRESH_CERTIFIED_AT,
        scenarios: [{ scenarioId: 'patch.synthetic', passed: true }],
      });
      const registry = registryWith({
        [testModel]: openrouterNativeModel(testModel),
      });

      const result = filterNativeModels([testModel], 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, 'insufficient-phase');
      assert.equal(result.rejected[0].certifiedPhase, 'patch');
    } finally {
      cleanup();
    }
  });

  it('all rejections include required diagnostic fields', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      // Set up multiple invalid models
      const certDir = join(repoDir, '.wavemill/native-agent-certifications/openrouter');

      // Missing: no artifact written for SAFE_MODEL_IDS[0]
      // Stale: stale certifiedAt for SAFE_MODEL_IDS[1]
      writeCertification(repoDir, workflowArtifact(SAFE_MODEL_IDS[1], {
        certifiedAt: STALE_CERTIFIED_AT,
      }));
      // Malformed: invalid JSON for SAFE_MODEL_IDS[2]
      const malformedDir = join(certDir, SAFE_MODEL_IDS[2]);
      mkdirSync(malformedDir, { recursive: true });
      writeFileSync(join(malformedDir, `${SUITE_VERSION}.json`), 'not json');

      const registry = buildTestRegistry();
      const result = filterNativeModels(SAFE_MODEL_IDS, 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, 3);

      for (const rejection of result.rejected) {
        assert.equal(rejection.role, 'planner');
        assert.equal(rejection.requestedPhase, 'workflow');
        assert.equal(rejection.nativeCapability, 'certified');
        assert.equal(rejection.requiredSuiteVersion, SUITE_VERSION);
        assert.ok(
          ['missing', 'stale', 'malformed', 'wrong-suite', 'insufficient-phase'].includes(rejection.reason),
          `rejection reason "${rejection.reason}" should be a known reason`,
        );
      }
    } finally {
      cleanup();
    }
  });

  it('fail-closed: pool with only invalid native models returns no eligible candidates', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      // No artifacts written at all
      const registry = buildTestRegistry();

      const result = filterNativeModels(SAFE_MODEL_IDS, 'planner', registry, repoDir, NOW);

      assert.deepEqual(result.eligible, []);
      assert.equal(result.rejected.length, SAFE_MODEL_IDS.length);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 6: Report JSON verification
// ---------------------------------------------------------------------------

describe('[workflow-planning-unlock] report JSON shows planner eligibility for certified models', () => {
  it('buildModelCertificationReport shows ready state with all eligible stages for workflow-certified models', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeWorkflowArtifactsForAllModels(repoDir);
      const registry = buildTestRegistry();

      const rows = buildModelCertificationReport({
        repoDir,
        registry,
        now: NOW,
      });

      for (const safeId of SAFE_MODEL_IDS) {
        const row = rows.find(r => r.model === safeId);
        assert.ok(row, `row for ${safeId} should exist`);
        assert.equal(row.state, 'ready', `${safeId} should be ready`);
        assert.equal(row.certifiedPhase, 'workflow', `${safeId} certified phase should be workflow`);
        assert.ok(
          row.eligibleStages.includes('planner'),
          `${safeId} should be eligible for planner`,
        );
        assert.ok(
          row.eligibleStages.includes('coder'),
          `${safeId} should be eligible for coder`,
        );
        assert.ok(
          row.eligibleStages.includes('reviewer'),
          `${safeId} should be eligible for reviewer`,
        );
        assert.equal(row.suiteVersion, SUITE_VERSION);
        assert.ok(
          row.scenarios.length > 0,
          `${safeId} should have scenarios from artifact (not registry-only fallback)`,
        );
        assert.ok(
          row.scenarios.every(s => s.passed),
          `${safeId} all scenarios should pass`,
        );
      }
    } finally {
      cleanup();
    }
  });

  it('serializeReport produces stable JSON with planner-eligible models', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeWorkflowArtifactsForAllModels(repoDir);
      const registry = buildTestRegistry();

      const rows = buildModelCertificationReport({
        repoDir,
        registry,
        now: NOW,
      });
      const report = serializeReport(rows, NOW);

      assert.equal(report.schemaVersion, 1);
      assert.equal(report.generatedAt, NOW.toISOString());
      assert.equal(report.models.length, SAFE_MODEL_IDS.length);

      for (const model of report.models) {
        assert.ok(SAFE_MODEL_IDS.includes(model.model), `${model.model} should be a target model`);
        assert.equal(model.state, 'ready');
        assert.deepEqual(
          model.eligibleStages.sort(),
          ['coder', 'planner', 'reviewer'],
        );
      }
    } finally {
      cleanup();
    }
  });

  it('report sourced from artifacts not registry-only fallback', () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeWorkflowArtifactsForAllModels(repoDir);
      const registry = buildTestRegistry();

      const rows = buildModelCertificationReport({
        repoDir,
        registry,
        now: NOW,
      });

      for (const safeId of SAFE_MODEL_IDS) {
        const row = rows.find(r => r.model === safeId);
        assert.ok(row, `row for ${safeId} should exist`);
        assert.ok(
          row.scenarios.length > 0,
          `${safeId} should have scenarios (artifact-sourced), got ${row.scenarios.length}`,
        );
      }
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 6 (CLI): native-agent-models-report --json via temp repo config
// ---------------------------------------------------------------------------

describe('[workflow-planning-unlock] CLI report surface', () => {
  it('native-agent-models-report --repo --json shows planner eligibility for workflow-certified models', async () => {
    const { repoDir, cleanup } = makeRepo();
    try {
      writeWorkflowArtifactsForAllModels(repoDir);

      // Write config with model registry entries so CLI picks them up
      const registryModels: Record<string, unknown> = {};
      for (const safeId of SAFE_MODEL_IDS) {
        registryModels[safeId] = openrouterNativeModel(safeId);
      }
      writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
        modelRegistry: { models: registryModels },
      }));
      clearConfigCache(repoDir);

      const { execSync } = await import('node:child_process');
      const toolPath = join(process.cwd(), 'tools/native-agent-models-report.ts');
      const stdout = execSync(
        `node --import tsx/esm ${toolPath} --repo ${repoDir} --json`,
        { encoding: 'utf-8', timeout: 30_000 },
      );

      const report = JSON.parse(stdout);
      assert.ok(report.models, 'report should have models array');

      for (const safeId of SAFE_MODEL_IDS) {
        const model = report.models.find((m: { model: string }) => m.model === safeId);
        assert.ok(model, `CLI report should include ${safeId}`);
        assert.equal(model.state, 'ready', `${safeId} should be ready`);
        assert.ok(
          model.eligibleStages.includes('planner'),
          `${safeId} should be eligible for planner in CLI output`,
        );
      }
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence: model ID mapping
// ---------------------------------------------------------------------------

describe('[workflow-planning-unlock] evidence: model ID mapping', () => {
  it('documents raw OpenRouter ID to safe path ID mapping for all target models', () => {
    for (const { raw, safe } of TARGET_MODELS) {
      assert.ok(
        !safe.includes('/'),
        `safe ID "${safe}" must not contain slashes`,
      );
      assert.throws(
        () => buildCertificationPath('/tmp/test', 'openrouter', raw, 'v1'),
        /Invalid certification path segment/,
        `raw ID "${raw}" must be rejected by path builder`,
      );
      assert.doesNotThrow(
        () => buildCertificationPath('/tmp/test', 'openrouter', safe, 'v1'),
        `safe ID "${safe}" must be accepted by path builder`,
      );
    }
  });
});

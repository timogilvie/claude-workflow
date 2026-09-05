import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildModelCertificationReport,
  serializeReport,
  renderReportTable,
} from './report.ts';
import { CERTIFICATION_SCHEMA_VERSION, CERTIFICATION_TTL_DAYS } from './schema.ts';
import { buildLiveCodingCanaryFixture } from './canary-fixtures.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV } from './storage.ts';
import { resolveCertificationSubject } from './identity.ts';
import type { ModelRegistry } from '../../model-registry.ts';
import type { NativeCertificationArtifact } from './schema.ts';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-15T12:00:00.000Z');
const FRESH_DATE = new Date('2026-01-01T00:00:00.000Z').toISOString();
const STALE_DATE = new Date(NOW.getTime() - (CERTIFICATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
// Within the (shorter) live-canary TTL relative to NOW.
const CANARY_FRESH_DATE = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

function makeRegistry(overrides: Record<string, unknown> = {}): ModelRegistry {
  return {
    models: {
      'gpt-4o': {
        vendor: 'openai',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
        contextWindowTokens: 128_000,
        toolSupport: { functionCalling: true, streamingTools: true },
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 3,
        costPerMillionOutputTokensUsd: 15,
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
          certification: {
            maxCertifiedPhase: 'read-only',
            certifiedAt: FRESH_DATE,
            certificationSuiteVersion: 'v1',
          },
        },
      },
      'partial-model': {
        vendor: 'openrouter',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
        contextWindowTokens: 128_000,
        toolSupport: { functionCalling: true, streamingTools: true },
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 3,
        costPerMillionOutputTokensUsd: 15,
        nativeCapability: {
          nativeProvider: 'openrouter',
          piTransportKind: 'openai-completions',
          readOnlyNative: 'partial',
        },
      },
      'unsupported-model': {
        vendor: 'openai',
        class: 'fast_economy',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 60, planning: 65, coding: 70, review: 65, classify: 60 },
        contextWindowTokens: 16_000,
        toolSupport: { functionCalling: false, streamingTools: false },
        multimodal: { text: true, image: false },
        latencyTier: 'fast',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-completions',
          readOnlyNative: 'unsupported',
        },
      },
      'no-cert-model': {
        vendor: 'openai',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
        contextWindowTokens: 128_000,
        toolSupport: { functionCalling: true, streamingTools: true },
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 3,
        costPerMillionOutputTokensUsd: 15,
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
          // No certification metadata
        },
      },
      'non-native-model': {
        vendor: 'anthropic',
        class: 'strong_generalist',
        strengths: [],
        weaknesses: [],
        qualityScores: { routing: 70, planning: 75, coding: 80, review: 75, classify: 70 },
        contextWindowTokens: 200_000,
        toolSupport: { functionCalling: true, streamingTools: true },
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 3,
        costPerMillionOutputTokensUsd: 15,
      },
      ...overrides,
    } as ModelRegistry['models'],
    ladders: {},
  };
}

function makeArtifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: 'openai',
    model: 'gpt-4o',
    phase: 'read-only',
    suiteVersion: 'v1',
    certifiedAt: FRESH_DATE,
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
}

function makeTempRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-cert-report-'));
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

// A loadCertification stub that returns a fresh, passing artifact for gpt-4o
function makeLoadFn(artifactOverrides: Partial<NativeCertificationArtifact> = {}) {
  return (repoDir: string, provider: string, model: string, suiteVersion: string) => {
    if (model === 'gpt-4o' && suiteVersion === 'v1') {
      return { ok: true as const, artifact: makeArtifact(artifactOverrides) };
    }
    return { ok: false as const, reason: 'missing' as const };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildModelCertificationReport', () => {
  it('returns ready state for a fresh, passing on-disk artifact', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'ready-for-challenge');
    assert.equal(row.certifiedPhase, 'read-only');
    assert.deepEqual(row.eligibleStages, ['reviewer']);
    assert.equal(row.suiteVersion, 'v1');
    assert.equal(row.scenarios.length, 1);
    assert.equal(row.scenarios[0].passed, true);
  });

  it('returns stale state when artifact TTL is exceeded', () => {
    const staleArtifact = makeArtifact({ certifiedAt: STALE_DATE });
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: true as const, artifact: staleArtifact }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'stale');
    assert.deepEqual(row.eligibleStages, []);
  });

  it('returns uncertified state when scenarios fail', () => {
    const failedArtifact = makeArtifact({
      scenarios: [{ scenarioId: 's1', passed: false, failureMessage: 'assertion failed' }],
    });
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: true as const, artifact: failedArtifact }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'not-certified');
    assert.deepEqual(row.eligibleStages, []);
    assert.equal(row.scenarios[0].failureMessage, 'assertion failed');
  });

  it('returns unsupported state for unsupported-model', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
    });

    const row = rows.find(r => r.model === 'unsupported-model');
    assert.ok(row, 'unsupported-model row missing');
    assert.equal(row.state, 'certified-unavailable');
    assert.deepEqual(row.eligibleStages, []);
    assert.equal(row.scenarios.length, 0);
  });

  it('returns certification-only state for partial model', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
    });

    const row = rows.find(r => r.model === 'partial-model');
    assert.ok(row, 'partial-model row missing');
    assert.equal(row.state, 'certified-unavailable');
    assert.deepEqual(row.eligibleStages, []);
  });

  it('returns uncertified when no certification metadata exists', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
    });

    const row = rows.find(r => r.model === 'no-cert-model');
    assert.ok(row, 'no-cert-model row missing');
    assert.equal(row.state, 'not-certified');
  });

  it('excludes non-native models', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
    });

    assert.ok(!rows.find(r => r.model === 'non-native-model'), 'non-native-model should be excluded');
  });

  it('fails closed when the artifact is missing even if registry metadata is fresh', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: false as const, reason: 'missing' as const }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'not-certified');
    assert.deepEqual(row.eligibleStages, []);
    assert.equal(row.scenarios.length, 0);
  });

  it('fails closed when the artifact suite version does not match the registry metadata', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: true as const, artifact: makeArtifact({ suiteVersion: 'v0' }) }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'not-certified');
    assert.deepEqual(row.eligibleStages, []);
  });

  it('fails closed when the artifact identity does not match the requested provider/model', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: true as const, artifact: makeArtifact({ provider: 'openrouter', model: 'other-model' }) }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'not-certified');
    assert.deepEqual(row.eligibleStages, []);
  });

  it('filters by provider', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
      provider: 'openai',
    });

    assert.ok(rows.every(r => r.provider === 'openai'), 'all rows should be openai provider');
    assert.ok(!rows.find(r => r.model === 'partial-model'), 'partial-model (openrouter) excluded');
  });

  it('filters by model', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
      model: 'gpt-4o',
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'gpt-4o');
  });

  it('rows are sorted by (provider, model)', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
    });

    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      const cmp = a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
      assert.ok(cmp <= 0, `rows out of order: ${a.provider}/${a.model} > ${b.provider}/${b.model}`);
    }
  });

  it('workflow-phase artifact with a live canary pass is eligible for all stages', () => {
    const registry = makeRegistry();
    const subject = resolveCertificationSubject({ provider: 'openai', model: 'gpt-4o', registry });
    const workflowArtifact = makeArtifact({
      phase: 'workflow',
      subject: subject.subject,
      liveCanary: buildLiveCodingCanaryFixture(subject.subject, 'v1', { ranAt: CANARY_FRESH_DATE }),
    });
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: true as const, artifact: workflowArtifact }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'ready-for-challenge');
    assert.deepEqual(row.eligibleStages.sort(), ['coder', 'planner', 'reviewer'].sort());
    assert.equal(row.liveCanary.eligible, true);
    assert.equal(row.liveCanary.status, 'pass');
  });

  it('workflow-phase artifact without a live canary never gains the coder stage', () => {
    const workflowArtifact = makeArtifact({ phase: 'workflow' });
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: true as const, artifact: workflowArtifact }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.equal(row.state, 'ready-for-challenge');
    assert.deepEqual(row.eligibleStages.sort(), ['planner', 'reviewer'].sort());
    assert.equal(row.liveCanary.eligible, false);
    assert.equal(row.liveCanary.reason, 'missing');
  });

  it('failed live canary keeps coder excluded and surfaces the failure reason', () => {
    const registry = makeRegistry();
    const subject = resolveCertificationSubject({ provider: 'openai', model: 'gpt-4o', registry });
    const workflowArtifact = makeArtifact({
      phase: 'workflow',
      subject: subject.subject,
      liveCanary: buildLiveCodingCanaryFixture(subject.subject, 'v1', {
        ranAt: CANARY_FRESH_DATE,
        status: 'fail',
        reason: 'protocol_failure',
      }),
    });
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: () => ({ ok: true as const, artifact: workflowArtifact }),
    });

    const row = rows.find(r => r.model === 'gpt-4o');
    assert.ok(row, 'gpt-4o row missing');
    assert.deepEqual(row.eligibleStages.sort(), ['planner', 'reviewer'].sort());
    assert.equal(row.liveCanary.eligible, false);
    assert.equal(row.liveCanary.reason, 'failed');
    assert.equal(row.liveCanary.failureReason, 'protocol_failure');
  });

  it('loads mapped OpenRouter artifacts for aliased models', () => {
    const { repoDir, cleanup } = makeTempRepo();
    try {
      const certDir = join(repoDir, 'qwen', 'qwen3-coder');
      mkdirSync(certDir, { recursive: true });
      const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = repoDir;
      const registry = makeRegistry({
        'qwen-3-coder': {
          vendor: 'qwen',
          class: 'strong_generalist',
          strengths: [],
          weaknesses: [],
          qualityScores: { routing: 58, planning: 72, coding: 84, review: 78, classify: 58 },
          contextWindowTokens: 131_072,
          toolSupport: 'basic',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'standard',
          costPerMillionInputTokensUsd: 0.35,
          costPerMillionOutputTokensUsd: 1.05,
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'certified',
            compatFlags: { thinkingFormat: 'openrouter' },
            certification: {
              maxCertifiedPhase: 'workflow',
              certifiedAt: FRESH_DATE,
              certificationSuiteVersion: 'v1',
            },
          },
        },
      });
      const subject = resolveCertificationSubject({
        provider: 'openrouter',
        model: 'qwen-3-coder',
        registry,
      });
      writeFileSync(join(certDir, 'v1.json'), JSON.stringify({
        schemaVersion: CERTIFICATION_SCHEMA_VERSION,
        subject: subject.subject,
        provider: 'qwen',
        model: 'qwen3-coder',
        phase: 'workflow',
        suiteVersion: 'v1',
        certifiedAt: FRESH_DATE,
        scenarios: [{ scenarioId: 's1', passed: true }],
        liveCanary: buildLiveCodingCanaryFixture(subject.subject, 'v1', { ranAt: CANARY_FRESH_DATE }),
      }));

      const rows = buildModelCertificationReport({ registry, repoDir, now: NOW });
      const row = rows.find(r => r.model === 'qwen-3-coder');
      assert.ok(row, 'qwen-3-coder row missing');
      assert.equal(row.state, 'ready-for-challenge');
      assert.deepEqual(row.eligibleStages.sort(), ['coder', 'planner', 'reviewer'].sort());
      if (previousRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
      }
    } finally {
      cleanup();
    }
  });
});

describe('serializeReport', () => {
  it('produces stable JSON shape', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
      model: 'gpt-4o',
    });

    const report = serializeReport(rows, NOW);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.generatedAt, NOW.toISOString());
    assert.equal(report.models.length, 1);
    assert.equal(report.models[0].model, 'gpt-4o');
    assert.equal(report.models[0].state, 'ready-for-challenge');

    const json = JSON.stringify(report);
    assert.ok(json.includes('"schemaVersion":1'));
    assert.ok(json.includes('"generatedAt"'));
    assert.ok(json.includes('"models"'));
  });
});

describe('renderReportTable', () => {
  it('renders a table with headers and rows', () => {
    const registry = makeRegistry();
    const rows = buildModelCertificationReport({
      registry,
      now: NOW,
      loadCertificationFn: makeLoadFn(),
    });

    const table = renderReportTable(rows);
    assert.ok(table.includes('Provider'), 'should include Provider header');
    assert.ok(table.includes('Model'), 'should include Model header');
    assert.ok(table.includes('Status'), 'should include Status header');
    assert.ok(table.includes('openai'), 'should include openai provider');
    assert.ok(table.includes('ready-for-challenge'), 'should include ready state');
  });

  it('renders a message when no rows exist', () => {
    const table = renderReportTable([]);
    assert.ok(table.includes('No native-capable models'));
  });
});

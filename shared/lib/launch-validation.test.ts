import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { auditLaunchPriorityCoverage } from './launch-priority-audit.ts';
import {
  buildCatalogSnapshot,
  normalizeCatalog,
  type LaunchPriorityFixture,
  type LaunchPriorityModel,
  type OpenRouterModel,
} from './openrouter-catalog.ts';
import type { SmokeReport } from './openrouter-smoke.ts';
import {
  buildLaunchValidationArtifact,
  classifyLaunchPriorityTrack,
  resolveLaunchPriorityMetadata,
} from './launch-validation.ts';

function makeRecord(modelId: string, overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: overrides.id ?? `${modelId}-${Math.random().toString(16).slice(2)}`,
    schemaVersion: overrides.schemaVersion ?? '1.32.0',
    originalPrompt: overrides.originalPrompt ?? 'Validate launch-priority OpenRouter coverage',
    modelId,
    modelVersion: overrides.modelVersion ?? modelId,
    score: overrides.score ?? 0.9,
    scoreBand: overrides.scoreBand ?? 'Minor Feedback',
    timeSeconds: overrides.timeSeconds ?? 30,
    timestamp: overrides.timestamp ?? '2026-07-13T12:00:00.000Z',
    interventionRequired: overrides.interventionRequired ?? false,
    interventionCount: overrides.interventionCount ?? 0,
    interventionDetails: overrides.interventionDetails ?? [],
    rationale: overrides.rationale ?? 'fixture',
    outcomes: overrides.outcomes ?? { success: true },
    ...overrides,
  } as EvalRecord;
}

function makeFixture(models: LaunchPriorityModel[]): LaunchPriorityFixture {
  return {
    schemaVersion: 'fixture-test-v1',
    models,
  };
}

function buildSnapshot(
  fixture: LaunchPriorityFixture,
  liveModels: Map<string, OpenRouterModel>,
  generatedAt = '2026-07-13T15:00:00.000Z',
) {
  const normalized = normalizeCatalog(fixture.models, liveModels, { resolvedAt: generatedAt });
  return buildCatalogSnapshot(normalized.entries, normalized.blockers, 'f'.repeat(64), {
    generatedAt,
  });
}

function smokeOk(modelId: string, family: SmokeReport['family']): SmokeReport {
  return {
    modelId,
    family,
    status: 'ok',
    costUsd: 0.01,
  };
}

describe('launch-validation', () => {
  it('builds a grouped artifact with provenance, family evidence, and anchor-vs-target diagnostics', () => {
    const fixture = makeFixture([
      {
        wavemillAlias: 'claude-sonnet-5',
        openrouterId: 'anthropic/claude-sonnet-5',
        family: 'claude',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      },
      {
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'deepseek-v3',
        openrouterId: 'deepseek/deepseek-chat-v3',
        family: 'deepseek',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      },
    ]);
    const liveModels = new Map<string, OpenRouterModel>([
      ['anthropic/claude-sonnet-5', { id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200_000 }],
      ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', pricing: { prompt: '0.0000006', completion: '0.0000018' }, context_length: 262_144 }],
      ['deepseek/deepseek-chat-v3', { id: 'deepseek/deepseek-chat-v3', pricing: { prompt: '0.0000008', completion: '0.000002' }, context_length: 200_000 }],
      ['moonshotai/kimi-k2', { id: 'moonshotai/kimi-k2', pricing: { prompt: '0.0000009', completion: '0.0000022' }, context_length: 262_144 }],
    ]);
    const catalogSnapshot = buildSnapshot(fixture, liveModels);
    const evalRecords = [
      makeRecord('claude-sonnet-5'),
      makeRecord('claude-sonnet-5'),
      makeRecord('claude-sonnet-5'),
      makeRecord('claude-sonnet-5'),
      makeRecord('claude-sonnet-5'),
      makeRecord('qwen-3-coder'),
      makeRecord('deepseek-v3'),
      makeRecord('kimi-k2'),
    ];
    const audit = auditLaunchPriorityCoverage({
      catalog: catalogSnapshot,
      evalRecords,
      now: new Date('2026-07-13T15:00:00.000Z'),
      checkNativeCertification: () => ({ eligible: true }),
    });

    const artifact = buildLaunchValidationArtifact({
      catalogSnapshot,
      smokeReports: [
        smokeOk('claude-sonnet-5', 'claude'),
        smokeOk('qwen-3-coder', 'qwen'),
        smokeOk('deepseek-v3', 'deepseek'),
        smokeOk('kimi-k2', 'kimi'),
      ],
      smokeMode: 'fixture',
      smokePrompt: 'ping',
      launchPriorityFixture: fixture,
      launchPrioritySourceHash: 'f'.repeat(64),
      audit,
      now: new Date('2026-07-13T15:00:00.000Z'),
    });

    assert.equal(artifact.status, 'ok');
    assert.equal(artifact.provenance.launchPriorityList.schemaVersion, 'fixture-test-v1');
    assert.equal(artifact.provenance.catalogSnapshot.sourceHash, 'f'.repeat(64));
    assert.deepEqual(
      artifact.families.map((family) => [family.family, family.status]),
      [
        ['deepseek', 'covered'],
        ['kimi', 'covered'],
        ['qwen', 'covered'],
      ],
    );
    assert.equal(artifact.summary.smokeOkCount, 4);
    assert.equal(artifact.summary.gapCount, 0);
    assert.equal(artifact.summary.familyGapCount, 0);

    const claude = artifact.models.find((model) => model.wavemillAlias === 'claude-sonnet-5');
    assert.equal(claude?.track, 'anchor');
    assert.equal(claude?.totals.directEvidenceCount, 15);
    assert.ok(
      artifact.diagnostics.overrepresentedAnchors.some((entry) =>
        entry.wavemillAlias === 'claude-sonnet-5' && entry.excessEvidenceCount > 0),
    );
    assert.ok(
      artifact.diagnostics.underSampledTargets.some((entry) =>
        entry.wavemillAlias === 'qwen-3-coder'
        && entry.zeroEvidenceRoles.length === 0
        && entry.belowTargetRoles.length > 0),
    );
  });

  it('fails validation when a model has neither smoke coverage nor a documented blocker', () => {
    const fixture = makeFixture([
      {
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'deepseek-v3',
        openrouterId: 'deepseek/deepseek-chat-v3',
        family: 'deepseek',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      },
    ]);
    const liveModels = new Map<string, OpenRouterModel>([
      ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', pricing: { prompt: '0.0000006', completion: '0.0000018' }, context_length: 262_144 }],
      ['deepseek/deepseek-chat-v3', { id: 'deepseek/deepseek-chat-v3', pricing: { prompt: '0.0000008', completion: '0.000002' }, context_length: 200_000 }],
      ['moonshotai/kimi-k2', { id: 'moonshotai/kimi-k2', pricing: { prompt: '0.0000009', completion: '0.0000022' }, context_length: 262_144 }],
    ]);
    const catalogSnapshot = buildSnapshot(fixture, liveModels);
    const audit = auditLaunchPriorityCoverage({
      catalog: catalogSnapshot,
      evalRecords: [makeRecord('deepseek-v3')],
      now: new Date('2026-07-13T15:00:00.000Z'),
      checkNativeCertification: () => ({ eligible: true }),
    });

    const artifact = buildLaunchValidationArtifact({
      catalogSnapshot,
      smokeReports: [
        smokeOk('deepseek-v3', 'deepseek'),
        smokeOk('kimi-k2', 'kimi'),
      ],
      smokeMode: 'fixture',
      launchPriorityFixture: fixture,
      launchPrioritySourceHash: 'f'.repeat(64),
      audit,
      now: new Date('2026-07-13T15:00:00.000Z'),
    });

    assert.equal(artifact.status, 'failed');
    const qwen = artifact.models.find((model) => model.wavemillAlias === 'qwen-3-coder');
    assert.equal(qwen?.validationStatus, 'gap');
    assert.equal(qwen?.smoke.status, 'not-run');
  });

  it('marks target families as blocked when access blockers prevent coverage', () => {
    const fixture = makeFixture([
      {
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'deepseek-v3',
        openrouterId: 'deepseek/deepseek-chat-v3',
        family: 'deepseek',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      },
    ]);
    const catalogSnapshot = buildSnapshot(fixture, new Map());
    const artifact = buildLaunchValidationArtifact({
      catalogSnapshot,
      smokeReports: [],
      smokeMode: 'live',
      launchPriorityFixture: fixture,
      launchPrioritySourceHash: 'f'.repeat(64),
      audit: auditLaunchPriorityCoverage({
        catalog: catalogSnapshot,
        evalRecords: [],
        now: new Date('2026-07-13T15:00:00.000Z'),
        checkNativeCertification: () => ({ eligible: true }),
      }),
      now: new Date('2026-07-13T15:00:00.000Z'),
    });

    assert.equal(artifact.status, 'blocked');
    assert.deepEqual(
      artifact.families.map((family) => [family.family, family.status]),
      [
        ['deepseek', 'blocked'],
        ['kimi', 'blocked'],
        ['qwen', 'blocked'],
      ],
    );
    assert.ok(
      artifact.models.every((model) =>
        model.blockers.some((blocker) => blocker.source === 'catalog' && blocker.code === 'not_found_in_openrouter')),
    );
  });

  it('resolves launch-priority metadata and track from either alias or OpenRouter id', () => {
    const fixture = makeFixture([
      {
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
    ]);

    const byAlias = resolveLaunchPriorityMetadata('qwen-3-coder', {
      fixture,
      sourceHash: 'f'.repeat(64),
    });
    const byId = resolveLaunchPriorityMetadata('qwen/qwen3-coder', {
      fixture,
      sourceHash: 'f'.repeat(64),
    });

    assert.equal(byAlias?.track, 'target');
    assert.equal(byId?.wavemillAlias, 'qwen-3-coder');
    assert.equal(classifyLaunchPriorityTrack('claude'), 'anchor');
    assert.equal(classifyLaunchPriorityTrack('kimi'), 'target');
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import { auditLaunchPriorityCoverage, type LaunchPriorityAudit } from './launch-priority-audit.ts';
import type { LaunchPriorityModel } from './openrouter-catalog.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeLaunchPriorityModel(
  overrides: Partial<LaunchPriorityModel> & Pick<LaunchPriorityModel, 'wavemillAlias' | 'openrouterId'>,
): LaunchPriorityModel {
  return {
    wavemillAlias: overrides.wavemillAlias,
    openrouterId: overrides.openrouterId,
    family: overrides.family ?? 'qwen',
    status: overrides.status ?? 'active',
    priorityTier: overrides.priorityTier ?? 1,
    roleEligibility: overrides.roleEligibility ?? ['coding'],
  };
}

function makeRecord(
  modelId: string,
  overrides: Partial<EvalRecord> = {},
): EvalRecord {
  return {
    id: overrides.id ?? `${modelId}-${Math.random().toString(16).slice(2)}`,
    schemaVersion: overrides.schemaVersion ?? '1.32.0',
    originalPrompt: overrides.originalPrompt ?? 'Run a launch-priority audit fixture',
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
    routing: overrides.routing,
    taskDescriptor: overrides.taskDescriptor,
    attempted_model: overrides.attempted_model,
    ...overrides,
  } as EvalRecord;
}

function makeBaseCatalog(): LaunchPriorityModel[] {
  return [
    makeLaunchPriorityModel({
      wavemillAlias: 'qwen-3-coder',
      openrouterId: 'qwen/qwen3-coder',
      family: 'qwen',
      status: 'active',
      roleEligibility: ['coding'],
    }),
    makeLaunchPriorityModel({
      wavemillAlias: 'deepseek-v3',
      openrouterId: 'deepseek/deepseek-chat-v3-0324',
      family: 'deepseek',
      status: 'active',
      roleEligibility: ['coding'],
    }),
    makeLaunchPriorityModel({
      wavemillAlias: 'kimi-k2',
      openrouterId: 'moonshotai/kimi-k2',
      family: 'kimi',
      status: 'watchlist',
      roleEligibility: ['coding'],
    }),
    makeLaunchPriorityModel({
      wavemillAlias: 'glm-5.2',
      openrouterId: 'z-ai/glm-5.2',
      family: 'glm',
      status: 'active',
      roleEligibility: ['coding'],
    }),
    makeLaunchPriorityModel({
      wavemillAlias: 'claude-sonnet-5',
      openrouterId: 'anthropic/claude-sonnet-5',
      family: 'claude',
      status: 'active',
      roleEligibility: ['coding'],
    }),
  ];
}

function makeZeroEvidenceFixture(): { catalog: LaunchPriorityModel[]; records: EvalRecord[] } {
  const catalog = makeBaseCatalog();
  const records = [
    makeRecord('claude-sonnet-5'),
    makeRecord('claude-sonnet-5'),
    makeRecord('claude-sonnet-5'),
    makeRecord('claude-sonnet-5'),
    makeRecord('claude-sonnet-5', {
      taskDescriptor: {
        constraints: {
          models_available: ['qwen-3-coder', 'deepseek-v3', 'kimi-k2', 'claude-sonnet-5'],
          objective: 'coverage',
        },
      } as EvalRecord['taskDescriptor']['constraints'],
    }),
    makeRecord('kimi-k2', {
      taskDescriptor: {
        constraints: {
          models_available: ['qwen-3-coder', 'deepseek-v3', 'kimi-k2', 'claude-sonnet-5'],
          objective: 'coverage',
        },
      } as EvalRecord['taskDescriptor']['constraints'],
      score: 0.6,
      outcomes: { success: false },
    }),
    makeRecord('glm-5.2', {
      taskDescriptor: {
        constraints: {
          models_available: ['glm-5.2'],
          objective: 'coverage',
        },
      } as EvalRecord['taskDescriptor']['constraints'],
    }),
    makeRecord('glm-5.2', {
      taskDescriptor: {
        constraints: {
          models_available: ['glm-5.2'],
          objective: 'coverage',
        },
      } as EvalRecord['taskDescriptor']['constraints'],
    }),
  ];
  return { catalog, records };
}

const allowAllNativeCertification = () => ({ eligible: true });

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('launch-priority-audit', () => {
  it('reports zero-evidence and below-target launch-priority models', () => {
    const { catalog, records } = makeZeroEvidenceFixture();

    const audit = auditLaunchPriorityCoverage({
      catalog,
      evalRecords: records,
      now: new Date('2026-07-13T14:00:00.000Z'),
      checkNativeCertification: allowAllNativeCertification,
      costOfModel: (entry) => entry?.pricing.inputPerMTok ?? ({
        'qwen-3-coder': 0.2,
        'deepseek-v3': 0.4,
        'kimi-k2': 0.15,
        'glm-5.2': 0.1,
        'claude-sonnet-5': 3,
      }[entry?.wavemillAlias ?? ''] ?? null),
    });

    assert.deepEqual(audit.zeroEvidence, ['deepseek-v3', 'qwen-3-coder']);
    assert.deepEqual(audit.belowTarget, ['glm-5.2', 'kimi-k2']);
    assert.equal(audit.summary.byRole.coding.zero, 2);
    assert.equal(audit.summary.byRole.coding.below, 2);
    assert.equal(audit.summary.byRole.coding.at, 1);
  });

  it('treats an empty corpus as zero evidence for every launch-priority model', () => {
    const catalog = makeBaseCatalog();
    const audit = auditLaunchPriorityCoverage({
      catalog,
      evalRecords: [],
      now: new Date('2026-07-13T14:00:00.000Z'),
      checkNativeCertification: allowAllNativeCertification,
    });

    assert.deepEqual(audit.zeroEvidence, [
      'claude-sonnet-5',
      'deepseek-v3',
      'glm-5.2',
      'kimi-k2',
      'qwen-3-coder',
    ]);
    assert.deepEqual(audit.belowTarget, []);
  });

  it('returns empty collections when no launch-priority models are supplied', () => {
    const audit = auditLaunchPriorityCoverage({
      catalog: [],
      evalRecords: [],
      now: new Date('2026-07-13T14:00:00.000Z'),
    });

    assert.deepEqual(audit.models, []);
    assert.deepEqual(audit.zeroEvidence, []);
    assert.deepEqual(audit.belowTarget, []);
    assert.deepEqual(audit.samplingPlan, []);
  });

  it('scopes zero-evidence by role while preserving the alias summary', () => {
    const catalog = [
      makeLaunchPriorityModel({
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        roleEligibility: ['coding', 'review'],
      }),
    ];
    const records = [
      makeRecord('qwen-3-coder', {
        routing: {
          coder: {
            role: 'coder',
            requestedSelector: { kind: 'pinned', modelId: 'qwen-3-coder' },
            resolvedModelId: 'qwen-3-coder',
            sourceLayer: 'policy',
          },
        },
      }),
      makeRecord('qwen-3-coder', {
        routing: {
          coder: {
            role: 'coder',
            requestedSelector: { kind: 'pinned', modelId: 'qwen-3-coder' },
            resolvedModelId: 'qwen-3-coder',
            sourceLayer: 'policy',
          },
        },
      }),
      makeRecord('qwen-3-coder', {
        routing: {
          coder: {
            role: 'coder',
            requestedSelector: { kind: 'pinned', modelId: 'qwen-3-coder' },
            resolvedModelId: 'qwen-3-coder',
            sourceLayer: 'policy',
          },
        },
      }),
    ];

    const audit = auditLaunchPriorityCoverage({
      catalog,
      evalRecords: records,
      now: new Date('2026-07-13T14:00:00.000Z'),
      checkNativeCertification: allowAllNativeCertification,
    });

    const coding = audit.models.find((entry) => entry.wavemillAlias === 'qwen-3-coder' && entry.role === 'coding');
    const review = audit.models.find((entry) => entry.wavemillAlias === 'qwen-3-coder' && entry.role === 'review');

    assert.equal(coding?.status, 'at-target');
    assert.equal(review?.status, 'zero-evidence');
    assert.deepEqual(audit.zeroEvidence, ['qwen-3-coder']);
  });

  it('orders the sampling plan by tier, cost, alias, and role', () => {
    const catalog = [
      makeLaunchPriorityModel({
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
      }),
      makeLaunchPriorityModel({
        wavemillAlias: 'deepseek-v3',
        openrouterId: 'deepseek/deepseek-chat-v3-0324',
        family: 'deepseek',
      }),
      makeLaunchPriorityModel({
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        status: 'watchlist',
      }),
      makeLaunchPriorityModel({
        wavemillAlias: 'glm-5.2',
        openrouterId: 'z-ai/glm-5.2',
        family: 'glm',
      }),
    ];
    const records = [
      makeRecord('glm-5.2'),
    ];
    const pricing = new Map<string, number | null>([
      ['qwen-3-coder', 0.2],
      ['deepseek-v3', 0.4],
      ['kimi-k2', 0.15],
      ['glm-5.2', 0.1],
    ]);

    const audit = auditLaunchPriorityCoverage({
      catalog,
      evalRecords: records,
      now: new Date('2026-07-13T14:00:00.000Z'),
      checkNativeCertification: allowAllNativeCertification,
      costOfModel: (entry) => pricing.get(entry?.wavemillAlias ?? '') ?? null,
    });

    assert.deepEqual(
      audit.samplingPlan.map((entry) => entry.wavemillAlias),
      ['qwen-3-coder', 'deepseek-v3', 'kimi-k2', 'glm-5.2'],
    );
  });

  it('respects maxAttempts and pushes null-cost candidates to the end of a tier', () => {
    const { catalog, records } = makeZeroEvidenceFixture();

    const audit = auditLaunchPriorityCoverage({
      catalog,
      evalRecords: records,
      now: new Date('2026-07-13T14:00:00.000Z'),
      maxAttempts: 2,
      checkNativeCertification: allowAllNativeCertification,
      costOfModel: (entry) => (entry?.wavemillAlias === 'deepseek-v3' ? null : ({
        'qwen-3-coder': 0.2,
        'kimi-k2': 0.15,
        'glm-5.2': 0.1,
        'claude-sonnet-5': 3,
      }[entry?.wavemillAlias ?? ''] ?? null)),
    });

    assert.equal(audit.samplingPlan.length, 2);
    assert.deepEqual(
      audit.samplingPlan.map((entry) => entry.wavemillAlias),
      ['qwen-3-coder', 'deepseek-v3'],
    );
  });

  it('excludes blocked models from the sampling plan while keeping them in the audit rows', () => {
    const { catalog, records } = makeZeroEvidenceFixture();
    const audit = auditLaunchPriorityCoverage({
      catalog,
      evalRecords: records,
      now: new Date('2026-07-13T14:00:00.000Z'),
      openRouterAvailability: new Set(['qwen/qwen3-coder', 'anthropic/claude-sonnet-5', 'z-ai/glm-5.2']),
      checkNativeCertification: (_provider, model) =>
        model === 'deepseek-v3' ? { eligible: false, reason: 'missing' } : { eligible: true },
      quotaStatus: (modelId) => (modelId === 'kimi-k2' ? 'exhausted' : 'healthy'),
      costOfModel: () => 1,
    });

    const deepseek = audit.models.find((entry) => entry.wavemillAlias === 'deepseek-v3');
    const kimi = audit.models.find((entry) => entry.wavemillAlias === 'kimi-k2');
    const planAliases = audit.samplingPlan.map((entry) => entry.wavemillAlias);

    assert.ok(deepseek?.blockers.some((blocker) => blocker.reason === 'missing-native-certification'));
    assert.ok(kimi?.blockers.some((blocker) => blocker.reason === 'not-available-via-openrouter'));
    assert.ok(kimi?.blockers.some((blocker) => blocker.reason === 'quota-exhausted'));
    assert.deepEqual(planAliases, ['qwen-3-coder', 'glm-5.2']);
  });

  it('falls back to legacy modelId rows when attempted_model is absent', () => {
    const audit = auditLaunchPriorityCoverage({
      catalog: [
        makeLaunchPriorityModel({
          wavemillAlias: 'qwen-3-coder',
          openrouterId: 'qwen/qwen3-coder',
          family: 'qwen',
        }),
      ],
      evalRecords: [makeRecord('qwen/qwen3-coder')],
      now: new Date('2026-07-13T14:00:00.000Z'),
    });

    const row = audit.models[0];
    assert.equal(row?.directEvidenceCount, 1);
    assert.equal(row?.status, 'below-target');
  });

  it('prefers attempted_model over a fallback modelId when they differ', () => {
    const audit = auditLaunchPriorityCoverage({
      catalog: [
        makeLaunchPriorityModel({
          wavemillAlias: 'qwen-3-coder',
          openrouterId: 'qwen/qwen3-coder',
          family: 'qwen',
        }),
        makeLaunchPriorityModel({
          wavemillAlias: 'claude-sonnet-5',
          openrouterId: 'anthropic/claude-sonnet-5',
          family: 'claude',
        }),
      ],
      evalRecords: [
        makeRecord('claude-sonnet-5', {
          attempted_model: 'qwen/qwen3-coder',
          routing: {
            coder: {
              role: 'coder',
              requestedSelector: { kind: 'pinned', modelId: 'qwen-3-coder' },
              resolvedModelId: 'claude-sonnet-5',
              sourceLayer: 'fallback',
            },
          },
        }),
      ],
      now: new Date('2026-07-13T14:00:00.000Z'),
    });

    const byAlias = new Map(audit.models.map((entry) => [entry.wavemillAlias, entry]));
    assert.equal(byAlias.get('qwen-3-coder')?.directEvidenceCount, 1);
    assert.equal(byAlias.get('claude-sonnet-5')?.directEvidenceCount, 0);
  });

  it('is deterministic for the same input when now is fixed', () => {
    const fixture = makeZeroEvidenceFixture();
    const options = {
      catalog: fixture.catalog,
      evalRecords: fixture.records,
      now: new Date('2026-07-13T14:00:00.000Z'),
      costOfModel: () => 1,
    };

    const first = auditLaunchPriorityCoverage(options);
    const second = auditLaunchPriorityCoverage(options);

    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('warns and skips malformed JSONL lines when reading from disk', () => {
    const repoDir = makeTempDir('launch-priority-audit-');
    const evalsDir = join(repoDir, '.wavemill', 'evals');
    const evalsPath = join(evalsDir, 'evals.jsonl');
    const warn = mock.method(console, 'warn', () => undefined);

    mkdirSync(evalsDir, { recursive: true });
    writeFileSync(evalsPath, [
      JSON.stringify(makeRecord('qwen-3-coder')),
      '{"broken":',
      JSON.stringify(makeRecord('deepseek-v3')),
      '',
    ].join('\n'), 'utf-8');

    const audit = auditLaunchPriorityCoverage({
      repoDir,
      evalsPath,
      catalog: [
        makeLaunchPriorityModel({
          wavemillAlias: 'qwen-3-coder',
          openrouterId: 'qwen/qwen3-coder',
          family: 'qwen',
        }),
        makeLaunchPriorityModel({
          wavemillAlias: 'deepseek-v3',
          openrouterId: 'deepseek/deepseek-chat-v3-0324',
          family: 'deepseek',
        }),
      ],
      now: new Date('2026-07-13T14:00:00.000Z'),
    });

    assert.equal(audit.models.reduce((sum, entry) => sum + entry.directEvidenceCount, 0), 2);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /line 2/);
  });
});

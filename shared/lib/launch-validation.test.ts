import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord, RoutingDecision } from './eval-schema.ts';
import {
  buildCatalogSnapshot,
  normalizeCatalog,
  type LaunchPriorityFixture,
  type OpenRouterModel,
} from './openrouter-catalog.ts';
import type { OpenRouterTransport } from './openrouter-runtime.ts';
import { generateLaunchValidationReport } from './launch-validation.ts';

function makeRoutingDecision(modelId: string): RoutingDecision {
  return {
    candidates: [{ agentType: 'codex', modelId }],
    chosen: { agentType: 'codex', modelId },
    decisionPolicyVersion: 'fixture',
    decisionRationale: 'launch validation fixture',
  };
}

function makeRecord(
  modelId: string,
  overrides: Partial<EvalRecord> = {},
): EvalRecord {
  return {
    id: overrides.id ?? `${modelId}-${Math.random().toString(16).slice(2)}`,
    issueId: overrides.issueId ?? 'HOK-2235',
    schemaVersion: overrides.schemaVersion ?? '1.32.0',
    originalPrompt: overrides.originalPrompt ?? 'Launch validation fixture',
    modelId,
    modelVersion: overrides.modelVersion ?? modelId,
    score: overrides.score ?? 0.9,
    scoreBand: overrides.scoreBand ?? 'Minor Feedback',
    timeSeconds: overrides.timeSeconds ?? 30,
    timestamp: overrides.timestamp ?? '2026-07-13T15:00:00.000Z',
    interventionRequired: overrides.interventionRequired ?? false,
    interventionCount: overrides.interventionCount ?? 0,
    interventionDetails: overrides.interventionDetails ?? [],
    rationale: overrides.rationale ?? 'fixture',
    workflowCost: overrides.workflowCost ?? 2.5,
    outcomes: overrides.outcomes ?? { success: true },
    routingDecision: overrides.routingDecision ?? makeRoutingDecision(modelId),
    constraints: overrides.constraints ?? { maxCostUsd: 5 },
    ...overrides,
  } as EvalRecord;
}

function makeFixture(): LaunchPriorityFixture {
  return {
    schemaVersion: '1',
    models: [
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
    ],
  };
}

function makeCatalogSnapshot(fixture: LaunchPriorityFixture) {
  const models = new Map<string, OpenRouterModel>(
    fixture.models.map((model) => [
      model.openrouterId,
      {
        id: model.openrouterId,
        context_length: 200_000,
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
    ]),
  );
  const normalized = normalizeCatalog(fixture.models, models, { resolvedAt: '2026-07-13T15:00:00.000Z' });
  return buildCatalogSnapshot(normalized.entries, normalized.blockers, 'fixture-hash', {
    generatedAt: '2026-07-13T15:00:00.000Z',
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe('launch-validation', () => {
  it('builds a grouped validation artifact with complete model coverage and Hokusai provenance', async () => {
    const fixture = makeFixture();
    const report = await generateLaunchValidationReport({
      fixture,
      catalogSnapshot: makeCatalogSnapshot(fixture),
      smokeMode: 'fixture',
      coverageTargetPerRole: 2,
      maxAttempts: 10,
      now: new Date('2026-07-13T15:00:00.000Z'),
      checkNativeCertification: () => ({ eligible: true }),
      quotaStatus: () => 'healthy',
      evalRecords: [
        makeRecord('claude-sonnet-5'),
        makeRecord('claude-sonnet-5'),
        makeRecord('claude-sonnet-5'),
        makeRecord('claude-sonnet-5'),
        makeRecord('qwen-3-coder', {
          attempted_model: 'qwen/qwen3-coder',
          model_alias: 'qwen-3-coder',
        }),
        makeRecord('kimi-k2', {
          score: 0.5,
          scoreBand: 'Assisted Success',
          outcomes: { success: false },
        }),
      ],
    });

    assert.equal(report.smoke.models.length, 4);
    assert.equal(report.groupedAudit.models.length, 4);
    assert.deepEqual(report.groupedAudit.zeroEvidence, ['deepseek-v3']);
    assert.ok(report.coverageDiagnostics.overrepresentedAnchors.some((entry) => entry.wavemillAlias === 'claude-sonnet-5'));
    assert.equal(report.familyChecks.find((entry) => entry.family === 'qwen')?.status, 'satisfied');
    assert.equal(report.hokusai.validRows > 0, true);
    assert.equal(report.hokusai.provenancePreview.launch_priority_catalog_generated_at, '2026-07-13T15:00:00.000Z');
    assert.equal(report.hokusai.provenancePreview.launch_priority_catalog_source_hash, 'fixture-hash');
    assert.equal(report.hokusai.provenancePreview.launch_priority_list_version, 'launch-priority-fixture.v1.json');
    assert.equal(report.hokusai.provenancePreview.launch_priority_fixture_hash.length > 0, true);
  });

  it('maps live smoke blockers for provider access, auth/rate-limit, unsupported parameters, and malformed responses', async () => {
    const fixture = makeFixture();
    const snapshot = makeCatalogSnapshot(fixture);
    const transport: OpenRouterTransport = async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { model: string };
      switch (payload.model) {
        case 'anthropic/claude-sonnet-5':
          return jsonResponse({ id: 'malformed' }, 200);
        case 'qwen/qwen3-coder':
          return jsonResponse({ error: { message: 'bad key' } }, 401);
        case 'deepseek/deepseek-chat-v3':
          return jsonResponse({ error: { message: 'slow down' } }, 429);
        case 'moonshotai/kimi-k2':
          return jsonResponse({ error: { message: 'unsupported', code: 'unsupported_parameter' } }, 400);
        default:
          return jsonResponse({ error: { message: 'unexpected' } }, 503);
      }
    };

    const report = await generateLaunchValidationReport({
      fixture,
      catalogSnapshot: snapshot,
      smokeMode: 'live',
      apiKey: 'test-key',
      transport,
      coverageTargetPerRole: 1,
      now: new Date('2026-07-13T15:00:00.000Z'),
      checkNativeCertification: () => ({ eligible: true }),
      quotaStatus: () => 'healthy',
      evalRecords: [],
    });

    const smokeByAlias = new Map(report.smoke.models.map((entry) => [entry.wavemillAlias, entry]));
    assert.equal(smokeByAlias.get('claude-sonnet-5')?.code, 'model_response_error');
    assert.equal(smokeByAlias.get('qwen-3-coder')?.code, 'auth_rate_limit');
    assert.equal(smokeByAlias.get('deepseek-v3')?.code, 'auth_rate_limit');
    assert.equal(smokeByAlias.get('kimi-k2')?.code, 'unsupported_parameter');
  });

  it('documents missing API key as a provider_unavailable smoke blocker', async () => {
    const fixture = makeFixture();
    const report = await generateLaunchValidationReport({
      fixture,
      catalogSnapshot: makeCatalogSnapshot(fixture),
      smokeMode: 'live',
      coverageTargetPerRole: 1,
      now: new Date('2026-07-13T15:00:00.000Z'),
      checkNativeCertification: () => ({ eligible: true }),
      quotaStatus: () => 'healthy',
      evalRecords: [],
    });

    assert.equal(report.smoke.summary.byCode.provider_unavailable, 4);
    assert.ok(report.smoke.models.every((entry) => entry.code === 'provider_unavailable'));
  });

  it('marks DeepSeek and Kimi challenger families blocked when every candidate has an external blocker', async () => {
    const fixture = makeFixture();
    const snapshot = makeCatalogSnapshot(fixture);
    const transport: OpenRouterTransport = async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { model: string };
      if (payload.model === 'qwen/qwen3-coder') {
        return jsonResponse({
          choices: [{ message: { content: 'pong' } }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }, 200);
      }
      return jsonResponse({ error: { message: 'unavailable' } }, 503);
    };

    const report = await generateLaunchValidationReport({
      fixture,
      catalogSnapshot: snapshot,
      smokeMode: 'live',
      apiKey: 'test-key',
      transport,
      coverageTargetPerRole: 1,
      now: new Date('2026-07-13T15:00:00.000Z'),
      checkNativeCertification: () => ({ eligible: true }),
      quotaStatus: () => 'healthy',
      evalRecords: [
        makeRecord('qwen-3-coder', {
          attempted_model: 'qwen/qwen3-coder',
          model_alias: 'qwen-3-coder',
        }),
      ],
    });

    assert.equal(report.familyChecks.find((entry) => entry.family === 'qwen')?.status, 'satisfied');
    assert.equal(report.familyChecks.find((entry) => entry.family === 'deepseek')?.status, 'blocked');
    assert.equal(report.familyChecks.find((entry) => entry.family === 'kimi')?.status, 'blocked');
  });
});

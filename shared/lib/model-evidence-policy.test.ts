import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EvalRecord, RoutingRole } from './eval-schema.ts';
import {
  evaluateEvidenceEligibility,
  extractCandidateModelRefs,
  extractExecutedModelRefs,
  partitionEvidence,
} from './model-evidence-policy.ts';

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-1',
    schemaVersion: '1.43.0',
    originalPrompt: 'Implement a backend feature',
    modelId: 'gpt-5.6-terra',
    modelVersion: 'gpt-5.6-terra',
    score: 0.8,
    scoreBand: 'Minor Feedback',
    timeSeconds: 120,
    timestamp: '2026-08-01T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'ok',
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: ['ts'],
          framework_tags: [],
          files_touched: 2,
          repo_size_loc: 1000,
          description_tokens: 50,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: true,
          cross_service: false,
        },
        learned: {
          complexity: 3,
          domain: 'backend',
          risk_flags: [],
        },
      },
      constraints: {
        models_available: ['gpt-5.6-terra'],
        objective: 'balanced',
      },
      stages: {
        planner: { model: 'gpt-5.6-terra' },
        coder: { model: 'gpt-5.6-terra' },
        reviewer: { model: 'gpt-5.6-terra' },
      },
    },
    ...overrides,
  } as EvalRecord;
}

function attribution(provisionalRoles: RoutingRole[] = [], candidateOnlyProvisional: string[] = []) {
  return {
    observedAt: '2026-08-01T00:00:00.000Z',
    roles: Object.fromEntries(
      (['planner', 'coder', 'reviewer'] as const).map((role) => [role, {
        alias: 'gpt-5.6-terra',
        identityStatus: 'verified' as const,
        identityRevision: 1,
        fingerprint: `${role}-fingerprint`,
        evidencePolicy: 'eligible' as const,
      }]),
    ),
    provisionalRoles,
    candidateOnlyProvisional,
  };
}

describe('model-evidence-policy', () => {
  it('extracts executed refs across routing, planning, attempted model, and descriptor stages', () => {
    const refs = extractExecutedModelRefs(makeRecord({
      routing: {
        planner: {
          role: 'planner',
          requestedSelector: { kind: 'pinned', modelId: 'planner-route' },
          resolvedModelId: 'planner-route',
          sourceLayer: 'test',
        },
        reviewer: {
          role: 'reviewer',
          requestedSelector: { kind: 'pinned', modelId: 'reviewer-route' },
          resolvedModelId: 'reviewer-route',
          sourceLayer: 'test',
        },
      },
      executedPlanning: { model: 'planner-executed' },
      planningExecutionOutcome: { model: 'planner-outcome' },
      attempted_model: 'coder-attempt',
    })).map((ref) => `${ref.role}:${ref.modelId}:${ref.path}`);

    assert.deepEqual(refs, [
      'planner:planner-route:routing.planner.resolvedModelId',
      'reviewer:reviewer-route:routing.reviewer.resolvedModelId',
      'planner:planner-executed:executedPlanning.model',
      'planner:planner-outcome:planningExecutionOutcome.model',
      'coder:coder-attempt:attempted_model',
      'planner:gpt-5.6-terra:taskDescriptor.stages.planner.model',
      'coder:gpt-5.6-terra:taskDescriptor.stages.coder.model',
      'reviewer:gpt-5.6-terra:taskDescriptor.stages.reviewer.model',
    ]);
  });

  it('extracts candidate refs from routing candidates and available-model constraints', () => {
    const refs = extractCandidateModelRefs(makeRecord({
      routingDecision: {
        candidates: [
          { agentType: 'codex', modelId: 'gpt-5.6-terra' },
          { agentType: 'codex', modelId: 'ox-alpha' },
        ],
        chosen: 0,
      },
      taskDescriptor: {
        ...makeRecord().taskDescriptor!,
        constraints: {
          models_available: ['claude-sonnet-4-6', 'ox-alpha'],
          objective: 'balanced',
        },
      },
    })).map((ref) => `${ref.modelId}:${ref.path}`);

    assert.deepEqual(refs, [
      'gpt-5.6-terra:routingDecision.candidates.0.modelId',
      'ox-alpha:routingDecision.candidates.1.modelId',
      'claude-sonnet-4-6:taskDescriptor.constraints.models_available.0',
      'ox-alpha:taskDescriptor.constraints.models_available.1',
    ]);
  });

  it('excludes provisional executed roles from router history and reports affected roles', () => {
    const decision = evaluateEvidenceEligibility(makeRecord({
      modelIdentityAttribution: attribution(['planner', 'coder']),
    }), 'router_history');

    assert.equal(decision.eligible, false);
    assert.deepEqual(decision.reasons, ['provisional_model_identity']);
    assert.deepEqual(decision.affectedRoles, ['coder', 'planner']);
  });

  it('keeps candidate-only provisional references for router history but excludes decision training', () => {
    const record = makeRecord({
      modelIdentityAttribution: attribution([], ['ox-alpha']),
    });

    assert.equal(evaluateEvidenceEligibility(record, 'router_history').eligible, true);
    assert.deepEqual(
      evaluateEvidenceEligibility(record, 'training_export').reasons,
      ['provisional_candidate_decision'],
    );
  });

  it('fails closed for stale true eligibility when strict registry fallback sees provisional execution', () => {
    const record = makeRecord({
      attempted_model: 'ox-alpha',
      trainingEligible: true,
      modelIdentityAttribution: attribution(),
    });

    assert.deepEqual(
      evaluateEvidenceEligibility(record, 'hokusai_contribution', { strict: true }),
      {
        eligible: false,
        reasons: ['registry_provisional_fallback'],
        affectedRoles: ['coder'],
      },
    );
  });

  it('keeps legacy missing attribution compatible for router history', () => {
    assert.equal(evaluateEvidenceEligibility(makeRecord(), 'router_history').eligible, true);
  });

  it('uses the launch-priority persistence reason for provisional observations', () => {
    const decision = evaluateEvidenceEligibility(makeRecord({
      attempted_model: 'ox-alpha',
    }), 'launch_priority_persistence');

    assert.deepEqual(decision.reasons, ['provisional-observation-only']);
    assert.deepEqual(decision.affectedRoles, ['coder']);
  });

  it('partitions mixed corpora with stable reason counts', () => {
    const mixed = [
      makeRecord({ id: 'verified' }),
      makeRecord({ id: 'executed-held', modelIdentityAttribution: attribution(['reviewer']) }),
      makeRecord({ id: 'candidate-held', modelIdentityAttribution: attribution([], ['ox-alpha']) }),
    ];

    const partition = partitionEvidence(mixed, 'training_export');

    assert.deepEqual(partition.eligible.map((record) => record.id), ['verified']);
    assert.deepEqual(partition.excluded.map(({ record }) => record.id), ['executed-held', 'candidate-held']);
    assert.deepEqual(partition.reasonCounts, {
      provisional_candidate_decision: 1,
      provisional_model_identity: 1,
    });
  });
});

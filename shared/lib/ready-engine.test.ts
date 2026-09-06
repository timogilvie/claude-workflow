import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkBaseBranch,
  checkChallengePairs,
  checkDependencies,
  checkMetadata,
  checkMigrationCoupling,
  checkRiskPolicy,
  evaluateReady,
  readRequiredChecks,
  type ReadyEngineContext,
} from './ready-engine.ts';
import { WM_LABELS } from './pr-state-labels.ts';

function buildContext(overrides: Partial<ReadyEngineContext> = {}): ReadyEngineContext {
  const {
    pr: prOverrides,
    config: configOverrides,
    fetchPrState,
    fetchLinearIssueState,
    readChallengeComparisons,
  } = overrides;

  const pr = {
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
    baseBranch: 'auto/integration',
    body: ['<!-- wavemill-meta', 'task: HOK-1436', '-->'].join('\n'),
    labels: [],
    mergedAt: null,
    ...(prOverrides ?? {}),
  };

  const config = {
    enabled: true,
    integrationBranch: 'auto/integration',
    riskPolicy: 'require-label',
    enforceMigrationCoupling: true,
    ...(configOverrides ?? {}),
  };

  return {
    pr,
    config,
    fetchPrState: fetchPrState ?? (async () => ({ state: 'MERGED', mergedAt: '2026-04-27T00:00:00Z' })),
    fetchLinearIssueState: fetchLinearIssueState ?? (async () => ({ completedAt: '2026-04-27T00:00:00Z', canceledAt: null })),
    readChallengeComparisons: readChallengeComparisons ?? (() => []),
    requiredCheckRead: overrides.requiredCheckRead,
  };
}

describe('checkBaseBranch', () => {
  it('fails when the base branch does not match the integration branch', async () => {
    const result = await checkBaseBranch(buildContext({
      pr: { baseBranch: 'main' } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.labels, [WM_LABELS.wrongBase]);
  });

  it('passes when the base branch matches', async () => {
    const result = await checkBaseBranch(buildContext());
    assert.equal(result.status, 'pass');
  });
});

describe('checkMetadata', () => {
  it('fails when the metadata block is missing', async () => {
    const result = await checkMetadata(buildContext({
      pr: { body: 'No metadata here.' } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.labels, [WM_LABELS.metadataInvalid]);
  });

  it('fails when the metadata block is malformed', async () => {
    const result = await checkMetadata(buildContext({
      pr: { body: ['<!-- wavemill-meta', 'risk: severe', '-->'].join('\n') } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
  });

  it('passes when metadata is valid', async () => {
    const result = await checkMetadata(buildContext({
      pr: { body: ['<!-- wavemill-meta', 'risk: high', '-->'].join('\n') } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'pass');
  });

  it('fails on unknown metadata keys (strict validation)', async () => {
    const result = await checkMetadata(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'task: HOK-1436', 'future_key: enabled', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.labels, [WM_LABELS.metadataInvalid]);
  });

  it('fails on #1324 review-infrastructure-note fixture', async () => {
    const result = await checkMetadata(buildContext({
      pr: {
        body: [
          '<!-- wavemill-meta',
          'task: HOK-2929',
          'review-infrastructure-note: native-context-window-exceeded — changeset too large',
          '-->',
        ].join('\n'),
      } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.labels, [WM_LABELS.metadataInvalid]);
  });
});

describe('readRequiredChecks', () => {
  it('fails when an observed required check is failing', () => {
    const result = readRequiredChecks({
      ok: true,
      requiredContexts: ['Shell and Unit Tests'],
      requiredSource: 'config',
      checks: [{ name: 'Shell and Unit Tests', status: 'failure', rawStatus: 'FAILURE' }],
    });

    assert.equal(result.status, 'fail');
    assert.match(result.reason ?? '', /Shell and Unit Tests/);
  });

  it('returns pending when required checks are missing from the observed set', () => {
    const result = readRequiredChecks({
      ok: true,
      requiredContexts: ['Shell and Unit Tests', 'Native Launch Certification'],
      requiredSource: 'config',
      checks: [{ name: 'Shell and Unit Tests', status: 'success', rawStatus: 'SUCCESS' }],
    });

    assert.equal(result.status, 'pending');
    assert.match(result.reason ?? '', /observed 1 of 2/);
  });

  it('passes when the required check set is complete and green', () => {
    const result = readRequiredChecks({
      ok: true,
      requiredContexts: ['Shell and Unit Tests'],
      requiredSource: 'config',
      checks: [{ name: 'Shell and Unit Tests', status: 'success', rawStatus: 'SUCCESS' }],
    });

    assert.equal(result.status, 'pass');
  });

  it('preserves read errors as pending', () => {
    const result = readRequiredChecks({
      ok: false,
      errorType: 'network',
      reason: 'network unavailable',
    });

    assert.equal(result.status, 'pending');
  });
});

describe('checkDependencies', () => {
  it('returns pending for open PR dependencies', async () => {
    const result = await checkDependencies(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'depends_on: ["PR#101"]', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
      fetchPrState: async () => ({ state: 'OPEN', mergedAt: null }),
    }));
    assert.equal(result.status, 'pending');
  });

  it('fails for closed unmerged PR dependencies', async () => {
    const result = await checkDependencies(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'depends_on: ["PR#101"]', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
      fetchPrState: async () => ({ state: 'CLOSED', mergedAt: null }),
    }));
    assert.equal(result.status, 'fail');
  });

  it('passes for merged PR dependencies', async () => {
    const result = await checkDependencies(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'depends_on: ["PR#101"]', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'pass');
  });

  it('fails for missing PR dependencies', async () => {
    const result = await checkDependencies(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'depends_on: ["PR#101"]', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
      fetchPrState: async () => null,
    }));
    assert.equal(result.status, 'fail');
  });

  it('returns pending for incomplete Linear dependencies', async () => {
    const result = await checkDependencies(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'depends_on_linear: ["HOK-101"]', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
      fetchLinearIssueState: async () => ({ completedAt: null, canceledAt: null }),
    }));
    assert.equal(result.status, 'pending');
  });

  it('passes for completed Linear dependencies', async () => {
    const result = await checkDependencies(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'depends_on_linear: ["HOK-101"]', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'pass');
  });

  it('fails for canceled Linear dependencies', async () => {
    const result = await checkDependencies(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'depends_on_linear: ["HOK-101"]', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
      fetchLinearIssueState: async () => ({ completedAt: null, canceledAt: '2026-04-27T00:00:00Z' }),
    }));
    assert.equal(result.status, 'fail');
  });
});

describe('checkMigrationCoupling', () => {
  it('fails when db:migration is missing wm:migration', async () => {
    const result = await checkMigrationCoupling(buildContext({
      pr: { labels: ['db:migration'] } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.labels, [WM_LABELS.migrationRequired]);
  });

  it('warns when wm:migration exists without db:migration', async () => {
    const result = await checkMigrationCoupling(buildContext({
      pr: { labels: [WM_LABELS.migration] } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'warn');
  });

  it('passes when both migration labels are present', async () => {
    const result = await checkMigrationCoupling(buildContext({
      pr: { labels: ['db:migration', WM_LABELS.migration] } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'pass');
  });

  it('passes when migration coupling is disabled', async () => {
    const result = await checkMigrationCoupling(buildContext({
      config: { enforceMigrationCoupling: false } as ReadyEngineContext['config'],
      pr: { labels: ['db:migration'] } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'pass');
  });
});

describe('checkRiskPolicy', () => {
  it('passes when the PR is not high risk', async () => {
    const result = await checkRiskPolicy(buildContext());
    assert.equal(result.status, 'pass');
  });

  it('fails when high risk is blocked', async () => {
    const result = await checkRiskPolicy(buildContext({
      config: { riskPolicy: 'block' } as ReadyEngineContext['config'],
      pr: { body: ['<!-- wavemill-meta', 'risk: high', '-->'].join('\n') } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
  });

  it('returns pending when acknowledgement is required but missing', async () => {
    const result = await checkRiskPolicy(buildContext({
      pr: { body: ['<!-- wavemill-meta', 'risk: high', '-->'].join('\n') } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'pending');
  });

  it('passes when the acknowledgement label is present', async () => {
    const result = await checkRiskPolicy(buildContext({
      pr: {
        body: ['<!-- wavemill-meta', 'risk: high', '-->'].join('\n'),
        labels: [WM_LABELS.riskAcknowledged],
      } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'pass');
  });

  it('warns when high risk is auto-allowed', async () => {
    const result = await checkRiskPolicy(buildContext({
      config: { riskPolicy: 'auto' } as ReadyEngineContext['config'],
      pr: { labels: ['Risk: High'] } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'warn');
  });
});

describe('checkChallengePairs', () => {
  it('fails when challenge metadata has no matching comparison', async () => {
    const result = await checkChallengePairs(buildContext({
      pr: { body: ['<!-- wavemill-meta', 'challenge: true', '-->'].join('\n') } as ReadyEngineContext['pr'],
    }));
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.labels, [WM_LABELS.challengeUnresolved]);
  });

  it('passes when a matching challenge comparison exists', async () => {
    const result = await checkChallengePairs(buildContext({
      pr: { body: ['<!-- wavemill-meta', 'challenge: true', '-->'].join('\n') } as ReadyEngineContext['pr'],
      readChallengeComparisons: () => [{
        challengePairId: 'pair-1',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'https://github.com/acme/widgets/pull/42',
        challengerPrUrl: 'https://github.com/acme/widgets/pull/43',
        primaryEvalScore: 0.9,
        challengerEvalScore: 0.8,
        winner: 'primary',
        winnerModel: 'a',
        rationale: 'better',
        dimensions: {
          completeness: { primary: 9, challenger: 8 },
          correctness: { primary: 9, challenger: 8 },
          code_quality: { primary: 9, challenger: 8 },
          intervention_impact: { primary: 9, challenger: 8 },
          autonomy: { primary: 9, challenger: 8 },
        },
        timestamp: '2026-04-27T00:00:00Z',
      }],
    }));
    assert.equal(result.status, 'pass');
  });

  it('passes when the PR is not marked as a challenge', async () => {
    const result = await checkChallengePairs(buildContext());
    assert.equal(result.status, 'pass');
  });

  it('fails when challenge comparisons cannot be read', async () => {
    const result = await checkChallengePairs(buildContext({
      pr: { body: ['<!-- wavemill-meta', 'challenge: true', '-->'].join('\n') } as ReadyEngineContext['pr'],
      readChallengeComparisons: () => {
        throw new Error('boom');
      },
    }));
    assert.equal(result.status, 'fail');
  });
});

describe('evaluateReady', () => {
  it('blocks merge readiness when required GitHub checks cannot be read', async () => {
    const result = await evaluateReady(buildContext({
      requiredCheckRead: {
        ok: false,
        errorType: 'command-failed',
        reason: 'gh pr view exited 1',
      },
    }));

    assert.equal(result.status, 'pending');
    assert.match(result.reasons.join('\n'), /Required GitHub check status could not be read/);
    assert.match(result.output.comment, /Required Checks Unavailable/);
  });

  it('applies verdict precedence fail over pending and warn', async () => {
    const result = await evaluateReady(buildContext({
      pr: {
        baseBranch: 'main',
        body: ['<!-- wavemill-meta', 'risk: high', 'depends_on: ["PR#101"]', '-->'].join('\n'),
        labels: ['db:migration'],
      } as ReadyEngineContext['pr'],
      fetchPrState: async () => ({ state: 'OPEN', mergedAt: null }),
    }));
    assert.equal(result.status, 'fail');
    assert.ok(result.reasons.some((reason) => reason.includes('requires `wm:migration`')));
  });

  it('returns pass with empty output when the policy is disabled', async () => {
    const result = await evaluateReady(buildContext({
      config: { enabled: false } as ReadyEngineContext['config'],
    }));
    assert.deepEqual(result, {
      status: 'pass',
      reasons: [],
      output: { labels: [], comment: '' },
    });
  });

  it('deduplicates labels across guard results', async () => {
    const result = await evaluateReady(buildContext({
      pr: {
        baseBranch: 'main',
        body: ['<!-- wavemill-meta', 'challenge: true', '-->'].join('\n'),
      } as ReadyEngineContext['pr'],
      readChallengeComparisons: () => [],
    }));
    assert.deepEqual(result.output.labels, [WM_LABELS.wrongBase, WM_LABELS.challengeUnresolved]);
  });
});

describe('readRequiredChecks', () => {
  it('passes through successful check reads', () => {
    assert.deepEqual(readRequiredChecks({
      ok: true,
      requiredContexts: ['Shell and Unit Tests'],
      requiredSource: 'config',
      checks: [{ name: 'Shell and Unit Tests', status: 'success', rawStatus: 'SUCCESS' }],
    }), { status: 'pass' });
  });

  it('returns a fail-closed pending result for malformed check data', () => {
    const result = readRequiredChecks({
      ok: false,
      errorType: 'malformed-json',
      reason: 'Unexpected token',
    });

    assert.equal(result.status, 'pending');
    assert.match(result.reason ?? '', /malformed-json/);
  });
});

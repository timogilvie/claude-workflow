import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WM_LABELS } from './pr-state-labels.ts';
import {
  formatStatusLine,
  selectNextCandidate,
  type GhPrListEntry,
  type IntegrationHealth,
  type SelectNextCandidateOptions,
  type TendDecision,
} from './tend-controller.ts';

function metadata(lines: string[] = ['task: HOK-1437']): string {
  return ['<!-- wavemill-meta', ...lines, '-->'].join('\n');
}

function pr(overrides: Partial<GhPrListEntry> = {}): GhPrListEntry {
  return {
    number: 1,
    title: 'Test PR',
    headRefName: 'task/test-pr',
    createdAt: '2026-04-01T00:00:00Z',
    isDraft: false,
    labels: [{ name: WM_LABELS.wavemill }, { name: WM_LABELS.ready }],
    body: metadata(),
    ...overrides,
  };
}

function label(name: string): { name: string } {
  return { name };
}

function buildTestOptions(
  prList: GhPrListEntry[],
  healthOverride: IntegrationHealth = { state: 'healthy' },
): SelectNextCandidateOptions & { cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-tend-'));
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({ integration: { integrationBranch: 'auto/integration' } }),
  );

  return {
    repoDir,
    prFetcher: async () => prList,
    healthChecker: async () => healthOverride,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

async function withDecision(
  prList: GhPrListEntry[],
  test: (decision: TendDecision) => void | Promise<void>,
  healthOverride?: IntegrationHealth,
): Promise<void> {
  const options = buildTestOptions(prList, healthOverride);
  try {
    const decision = await selectNextCandidate(options);
    await test(decision);
  } finally {
    options.cleanup();
  }
}

describe('selectNextCandidate filtering', () => {
  it('blocks draft PRs', async () => {
    await withDecision([pr({ isDraft: true })], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'draft');
    });
  });

  it('blocks PRs with the blocked label', async () => {
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.blocked)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'blocked-label');
    });
  });

  it('blocks PRs missing metadata', async () => {
    await withDecision([pr({ body: 'No metadata.' })], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'missing-metadata');
    });
  });

  it('blocks PRs without the ready label', async () => {
    await withDecision([
      pr({ labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'ready-failed:not-ready');
    });
  });

  it('blocks unresolved PR dependencies', async () => {
    await withDecision([
      pr({ body: metadata(['depends_on: ["PR#99"]']) }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'deps-unresolved');
    });
  });

  it('blocks unresolved Linear dependencies', async () => {
    await withDecision([
      pr({ body: metadata(['depends_on_linear: ["HOK-9999"]']) }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'deps-unresolved');
    });
  });

  it('blocks unresolved challenges', async () => {
    await withDecision([
      pr({
        body: metadata(['challenge: true']),
        labels: [label(WM_LABELS.wavemill), label(WM_LABELS.ready), label(WM_LABELS.challengeUnresolved)],
      }),
    ], (decision) => {
      assert.equal(decision.blocked[0]?.reason, 'challenges-unresolved');
    });
  });

  it('ignores non-Wavemill PRs', async () => {
    await withDecision([
      pr({ labels: [], body: 'No metadata.' }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 0);
      assert.equal(decision.nextPR, null);
    });
  });
});

describe('selectNextCandidate ordering and health', () => {
  it('sorts eligible PRs by dependency depth then created date', async () => {
    await withDecision([
      pr({ number: 3, createdAt: '2026-04-01T00:00:00Z', body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 1, createdAt: '2026-04-03T00:00:00Z' }),
      pr({ number: 2, createdAt: '2026-04-02T00:00:00Z' }),
      pr({ number: 4, createdAt: '2026-04-04T00:00:00Z', body: metadata(['depends_on: ["PR#3"]']) }),
    ], (decision) => {
      assert.deepEqual(decision.eligible.map((candidate) => candidate.number), [2, 1, 3, 4]);
      assert.deepEqual(decision.eligible.map((candidate) => candidate.dependencyDepth), [0, 0, 1, 2]);
      assert.equal(decision.nextPR, 2);
    });
  });

  it('short-circuits when integration health is unhealthy', async () => {
    await withDecision([pr()], (decision) => {
      assert.equal(decision.integrationHealth.state, 'unhealthy');
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 0);
      assert.equal(decision.nextPR, null);
    }, { state: 'unhealthy', reason: 'ci: failure' });
  });

  it('returns an empty decision for empty input', async () => {
    await withDecision([], (decision) => {
      assert.deepEqual(decision.eligible, []);
      assert.deepEqual(decision.blocked, []);
      assert.equal(decision.nextPR, null);
    });
  });

  it('reports mixed eligible and blocked counts', async () => {
    await withDecision([
      pr({ number: 1 }),
      pr({ number: 2, createdAt: '2026-04-02T00:00:00Z' }),
      pr({ number: 3, isDraft: true }),
      pr({ number: 4, body: 'No metadata.' }),
      pr({ number: 5, labels: [label(WM_LABELS.wavemill)] }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 2);
      assert.equal(decision.blocked.length, 3);
      assert.equal(decision.nextPR, 1);
    });
  });
});

describe('selectNextCandidate dependency cycles', () => {
  it('blocks a 2-cycle', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 2, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.deepEqual(decision.blocked.map((candidate) => candidate.reason), ['dependency-cycle', 'dependency-cycle']);
    });
  });

  it('blocks a 3-cycle', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#2"]']) }),
      pr({ number: 2, body: metadata(['depends_on: ["PR#3"]']) }),
      pr({ number: 3, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked.length, 3);
      assert.ok(decision.blocked.every((candidate) => candidate.reason === 'dependency-cycle'));
    });
  });

  it('blocks a self-loop', async () => {
    await withDecision([
      pr({ number: 1, body: metadata(['depends_on: ["PR#1"]']) }),
    ], (decision) => {
      assert.equal(decision.eligible.length, 0);
      assert.equal(decision.blocked[0]?.reason, 'dependency-cycle');
    });
  });
});

describe('formatStatusLine', () => {
  it('formats the dry-run status line', async () => {
    await withDecision([pr()], (decision) => {
      assert.match(formatStatusLine(decision), /^tend: integration=healthy eligible=1 blocked=0 next=PR#1$/);
    });
  });

  it('includes unhealthy reasons and none when no PR is selected', () => {
    assert.equal(
      formatStatusLine({
        integrationHealth: { state: 'unhealthy', reason: 'ci: failure' },
        eligible: [],
        blocked: [],
        nextPR: null,
      }),
      'tend: integration=unhealthy:ci: failure eligible=0 blocked=0 next=none',
    );
  });
});

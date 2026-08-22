import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  HARNESS_REPLAY_SCHEMA_VERSION,
  runHarnessReplay,
  validateHarnessReplaySuite,
  type HarnessReplayAdapterDeps,
  type HarnessReplayCase,
  type HarnessReplaySuite,
} from './harness-replay.ts';

const expectedExpansion = '# Task Packet\n\nDo the safe thing.\n';

function routeCase(id: string, overrides: Partial<Extract<HarnessReplayCase, { surface: 'routing' }>> = {}): HarnessReplayCase {
  return {
    schemaVersion: HARNESS_REPLAY_SCHEMA_VERSION,
    suiteVersion: 'test-suite',
    id,
    surface: 'routing',
    source: { kind: 'artifact', path: `.wavemill/evals/artifacts/${id}` },
    baselineStatus: 'pass',
    stable: true,
    input: {
      issueId: id,
      prompt: `Route ${id}`,
      expectedDecision: {
        planner: 'claude-opus-4-7',
        coder: 'gpt-5.3-codex',
        reviewer: 'claude-sonnet-5',
      },
    },
    ...overrides,
  };
}

function reviewCase(id: string): HarnessReplayCase {
  return {
    schemaVersion: HARNESS_REPLAY_SCHEMA_VERSION,
    suiteVersion: 'test-suite',
    id,
    surface: 'review',
    source: { kind: 'artifact', path: `.wavemill/evals/artifacts/${id}` },
    baselineStatus: 'pass',
    stable: true,
    input: {
      diff: 'diff --git a/file.ts b/file.ts',
      expectedVerdict: 'ready',
    },
  };
}

function evalCase(id: string): HarnessReplayCase {
  return {
    schemaVersion: HARNESS_REPLAY_SCHEMA_VERSION,
    suiteVersion: 'test-suite',
    id,
    surface: 'eval_judging',
    source: { kind: 'artifact', path: `.wavemill/evals/artifacts/${id}` },
    baselineStatus: 'pass',
    stable: true,
    input: {
      taskPrompt: 'Judge this stored artifact',
      outcomes: {
        success: true,
        review: { humanReviewRequired: false, rounds: 0, approvals: 1, changeRequests: 0 },
        rework: { agentIterations: 0 },
        delivery: { prCreated: true, merged: true },
      },
      expectedSuccess: true,
    },
  };
}

function expansionCase(id: string): HarnessReplayCase {
  return {
    schemaVersion: HARNESS_REPLAY_SCHEMA_VERSION,
    suiteVersion: 'test-suite',
    id,
    surface: 'issue_expansion',
    source: { kind: 'artifact', path: `.wavemill/evals/artifacts/${id}` },
    baselineStatus: 'pass',
    stable: true,
    input: {
      promptTemplate: '{{ISSUE_CONTEXT}}\n{{CODEBASE_CONTEXT}}',
      issueContext: 'HOK-1: add replay',
      expectedIncludes: ['Task Packet'],
    },
  };
}

function suite(cases: HarnessReplayCase[]): HarnessReplaySuite {
  return {
    schemaVersion: HARNESS_REPLAY_SCHEMA_VERSION,
    suiteVersion: 'test-suite',
    sampling: {
      previouslyPassing: cases.filter((testCase) => testCase.baselineStatus === 'pass').length,
      previouslyFailing: cases.filter((testCase) => testCase.baselineStatus === 'fail').length,
      incidentCases: 3,
      rule: 'test fixture',
    },
    holdOut: {
      promptIsolation: 'tests pass cases directly to replay only',
      refreshPolicy: 'test fixture',
    },
    probes: {
      stability: {
        repetitions: 3,
        excludedCaseIds: cases.filter((testCase) => !testCase.stable).map((testCase) => testCase.id),
        result: 'passed',
        evidence: 'test fixture',
      },
      coverage: {
        requiredCaught: 2,
        escalation: 'cheap_replay_sufficient',
        incidents: [
          { id: 'incident-ready-watchdog', incident: 'ready_watchdog_merge_lane', caught: true, evidence: 'route replay' },
          { id: 'incident-pairing-drift', incident: 'challenge_pairing_id_drift', caught: true, evidence: 'eval replay' },
          { id: 'incident-monitor-main', incident: 'monitor_bundle_main_regen', caught: false, evidence: 'needs workflow replay' },
        ],
      },
    },
    cases,
  };
}

function deps(): Partial<HarnessReplayAdapterDeps> {
  return {
    async routeBatch() {
      const candidate = process.env.WAVEMILL_REPLAY_HARNESS_LABEL === 'candidate';
      return [{
        issueId: 'HOK-1',
        prompt: 'Route',
        decision: {
          planner: 'claude-opus-4-7',
          coder: candidate ? 'wrong-coder' : 'gpt-5.3-codex',
          reviewer: 'claude-sonnet-5',
        },
      }];
    },
    async runReview() {
      return {
        verdict: 'ready',
        codeReviewFindings: [],
      };
    },
    async evaluateTask(_input, outcomes) {
      return {
        id: 'eval-test',
        schemaVersion: '1.41.0',
        originalPrompt: 'test',
        modelId: 'judge',
        modelVersion: 'judge',
        score: outcomes.success ? 1 : 0,
        timeSeconds: null,
        timestamp: new Date().toISOString(),
        interventionRequired: false,
        interventionCount: 0,
        interventionDetails: [],
        rationale: 'test',
        agentType: 'test',
        outcomes,
      };
    },
    async expandIssue() {
      return { text: expectedExpansion };
    },
  };
}

describe('harness replay', () => {
  it('computes D from exact baseline-pass candidate-fail comparisons and still passes at tolerance 1', async () => {
    const report = await runHarnessReplay({
      repoDir: process.cwd(),
      suite: suite([routeCase('route-1'), reviewCase('review-1'), evalCase('eval-1'), expansionCase('expand-1')]),
      baselineHarnessId: 'baseline-h',
      candidateHarnessId: 'candidate-h',
      tolerance: 1,
      mode: 'enforce',
      deps: deps(),
    });

    assert.equal(report.D, 1);
    assert.equal(report.verdict, 'pass');
    assert.equal(report.perSurface.routing.D, 1);
    assert.equal(report.perSurface.review.D, 0);
  });

  it('fails enforcement when D exceeds tolerance', async () => {
    const report = await runHarnessReplay({
      repoDir: process.cwd(),
      suite: suite([routeCase('route-1')]),
      baselineHarnessId: 'baseline-h',
      candidateHarnessId: 'candidate-h',
      tolerance: 0,
      mode: 'enforce',
      deps: deps(),
    });

    assert.equal(report.D, 1);
    assert.equal(report.verdict, 'fail');
  });

  it('excludes unstable cases instead of averaging them', async () => {
    const report = await runHarnessReplay({
      repoDir: process.cwd(),
      suite: suite([routeCase('unstable-route', { stable: false })]),
      baselineHarnessId: 'baseline-h',
      candidateHarnessId: 'candidate-h',
      mode: 'shadow',
      deps: deps(),
    });

    assert.equal(report.totals.cases, 0);
    assert.deepEqual(report.exclusions, [{ caseId: 'unstable-route', reason: 'unstable' }]);
  });

  it('classifies malformed cases explicitly and does not pass enforcement with invalid evidence', async () => {
    const bad = routeCase('bad-route');
    bad.input.prompt = '';
    const report = await runHarnessReplay({
      repoDir: process.cwd(),
      suite: suite([bad]),
      baselineHarnessId: 'baseline-h',
      candidateHarnessId: 'candidate-h',
      mode: 'enforce',
      deps: deps(),
    });

    assert.equal(report.totals.malformed, 1);
    assert.equal(report.verdict, 'fail');
  });

  it('rejects suites whose coverage probe catches fewer than two named incidents', () => {
    const badSuite = suite([routeCase('route-1')]);
    badSuite.probes.coverage.incidents = badSuite.probes.coverage.incidents.map((incident) => ({
      ...incident,
      caught: false,
    }));
    assert.throws(() => validateHarnessReplaySuite(badSuite), /coverage probe caught 0\/2/);
  });

  it('retains reports even when verdict passes', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'harness-replay-report-'));
    try {
      const report = await runHarnessReplay({
        repoDir,
        suite: suite([reviewCase('review-1')]),
        baselineHarnessId: 'baseline-h',
        candidateHarnessId: 'candidate-h',
        reportPath: '.wavemill/harness-replay/reports/report.json',
        deps: deps(),
      });
      assert.equal(report.verdict, 'pass');
      const persisted = JSON.parse(readFileSync(join(repoDir, '.wavemill/harness-replay/reports/report.json'), 'utf-8'));
      assert.equal(persisted.D, 0);
      assert.equal(persisted.verdict, 'pass');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('loads committed suite fixtures through schema validation', () => {
    const path = join(process.cwd(), 'shared/fixtures/harness-replay/harness-retention-v1/manifest.json');
    const fixture = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = validateHarnessReplaySuite(fixture);
    assert.equal(parsed.suiteVersion, 'harness-retention-v1');
    assert.equal(parsed.cases.length >= 200, true);
    assert.equal(parsed.cases.length <= 400, true);
  });
});

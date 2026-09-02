import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCiChecks,
  fetchPrCiStatus,
  normalizeStatusCheckRollup,
  resolveRequiredContexts,
  type PrCiStatusDeps,
} from './pr-ci-status.ts';

const checks = (items: Array<{ name: string; status?: string; conclusion?: string; state?: string; bucket?: string }>) =>
  normalizeStatusCheckRollup(items);

test('one observed success of three required contexts is pending', () => {
  const result = evaluateCiChecks(
    checks([{ name: 'Shell and Unit Tests', conclusion: 'SUCCESS' }]),
    ['Shell and Unit Tests', 'Native Launch Certification', 'Check Lifecycle Paths'],
  );

  assert.equal(result.conclusion, 'pending');
  assert.equal(result.observed, 1);
  assert.deepEqual(result.missingRequired, ['Native Launch Certification', 'Check Lifecycle Paths']);
});

test('optional failing check fails even when required checks pass', () => {
  const result = evaluateCiChecks(
    checks([
      { name: 'Shell and Unit Tests', conclusion: 'SUCCESS' },
      { name: 'Optional Smoke', conclusion: 'FAILURE' },
    ]),
    ['Shell and Unit Tests'],
  );

  assert.equal(result.conclusion, 'fail');
  assert.deepEqual(result.failing, ['Optional Smoke']);
});

test('failure-set states fail CI evaluation', () => {
  const result = evaluateCiChecks(
    checks([
      { name: 'Shell and Unit Tests', conclusion: 'SUCCESS' },
      { name: 'Flaky Integration', conclusion: 'TIMED_OUT' },
    ]),
    ['Shell and Unit Tests'],
  );

  assert.equal(result.conclusion, 'fail');
  assert.deepEqual(result.failing, ['Flaky Integration']);
  assert.deepEqual(result.pending, []);
});

test('unrecognized check state waits instead of failing', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  try {
    const normalized = checks([
      { name: 'Shell and Unit Tests', conclusion: 'SUCCESS' },
      { name: 'Preflight Checks', status: 'CREATED' },
    ]);
    const result = evaluateCiChecks(normalized, ['Shell and Unit Tests']);

    assert.equal(normalized[1].status, 'unknown');
    assert.equal(normalized[1].rawStatus, 'CREATED');
    assert.equal(result.conclusion, 'pending');
    assert.deepEqual(result.failing, []);
    assert.deepEqual(result.pending, ['Preflight Checks']);
    assert.match(warnings.join('\n'), /Preflight Checks/);
    assert.match(warnings.join('\n'), /CREATED/);
  } finally {
    console.warn = originalWarn;
  }
});

test('optional skipped and neutral checks are passing', () => {
  const result = evaluateCiChecks(
    checks([
      { name: 'Shell and Unit Tests', conclusion: 'SUCCESS' },
      { name: 'Lint', conclusion: 'SKIPPED' },
      { name: 'Coverage', conclusion: 'NEUTRAL' },
    ]),
    ['Shell and Unit Tests'],
  );

  assert.equal(result.conclusion, 'pass');
  assert.equal(result.passing, 3);
});

test('zero checks are pending by default and none when checks are optional', () => {
  assert.equal(evaluateCiChecks([], []).conclusion, 'pending');
  assert.equal(evaluateCiChecks([], [], { requireChecks: false }).conclusion, 'none');
});

test('unknown required contexts pass only when all observed checks are complete', () => {
  assert.equal(evaluateCiChecks(checks([{ name: 'Lint', conclusion: 'SUCCESS' }]), []).conclusion, 'pass');
  assert.equal(evaluateCiChecks(checks([{ name: 'Lint', status: 'IN_PROGRESS' }]), []).conclusion, 'pending');
});

test('empty GitHub conclusion falls back to queued status', () => {
  const normalized = checks([{ name: 'Lint', conclusion: '', status: 'QUEUED' }]);
  const result = evaluateCiChecks(normalized, ['Lint']);

  assert.equal(normalized[0].status, 'pending');
  assert.equal(normalized[0].rawStatus, 'QUEUED');
  assert.equal(result.conclusion, 'pending');
  assert.deepEqual(result.pending, ['Lint']);
});

test('normalizer maps gh pr checks bucket values and dedupes newer reruns', () => {
  const result = normalizeStatusCheckRollup([
    { name: 'Lint', bucket: 'fail', completedAt: '2026-08-21T19:00:00Z' },
    { name: 'Lint', bucket: 'pass', completedAt: '2026-08-21T19:01:00Z' },
    { name: 'Tests', bucket: 'pending' },
  ]);

  assert.deepEqual(result.map((check) => [check.name, check.status]), [
    ['Lint', 'success'],
    ['Tests', 'pending'],
  ]);
});

test('resolveRequiredContexts uses branch protection before config fallback', async () => {
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => 'owner/repo',
    getIntegrationRequiredChecks: () => ['Config Check'],
    execFile: async () => ({ stdout: '["Shell and Unit Tests"]', stderr: '' }),
  };

  const result = await resolveRequiredContexts('auto/integration', '/repo', deps);
  assert.deepEqual(result, { contexts: ['Shell and Unit Tests'], source: 'branch-protection' });
});

test('resolveRequiredContexts falls back to config when branch protection read fails', async () => {
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => 'owner/repo',
    getIntegrationRequiredChecks: () => ['Shell and Unit Tests'],
    execFile: async () => {
      throw new Error('HTTP 403');
    },
  };

  const result = await resolveRequiredContexts('auto/integration', '/repo', deps);
  assert.equal(result.source, 'config');
  assert.deepEqual(result.contexts, ['Shell and Unit Tests']);
  assert.equal(result.readError?.errorType, 'unknown');
});

test('fetchPrCiStatus returns unknown on malformed JSON', async () => {
  const result = await fetchPrCiStatus(1186, '/repo', {
    execFile: async () => ({ stdout: '{not-json', stderr: '' }),
  });

  assert.equal(result.conclusion, 'unknown');
  assert.equal(result.readError?.errorType, 'malformed-json');
});

test('fetchPrCiStatus never evaluates checks from a superseded head (REQ-F4)', async () => {
  // The PR #1301 scenario: the caller pushed new000, but GitHub still reports
  // the old head old000 with a cancelled rollup. The cancelled run belongs to
  // the superseded head and must neither block nor satisfy readiness.
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => undefined,
    getIntegrationRequiredChecks: () => ['Shell and Unit Tests'],
    execFile: async () => ({
      stdout: JSON.stringify({
        headRefOid: 'old000',
        state: 'OPEN',
        statusCheckRollup: [{ name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'CANCELLED' }],
      }),
      stderr: '',
    }),
  };

  const result = await fetchPrCiStatus(1301, '/repo', deps, { expectedHeadSha: 'new000' });

  assert.equal(result.conclusion, 'pending');
  assert.equal(result.readError?.errorType, 'head-mismatch');
  assert.match(result.readError?.reason ?? '', /old000/);
  assert.match(result.readError?.reason ?? '', /new000/);
  assert.equal(result.headSha, 'old000');
  assert.deepEqual(result.failing, []);
  assert.deepEqual(result.checks, []);
});

test('fetchPrCiStatus evaluates normally when the expected head matches (REQ-F4)', async () => {
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => undefined,
    getIntegrationRequiredChecks: () => ['Shell and Unit Tests'],
    execFile: async () => ({
      stdout: JSON.stringify({
        headRefOid: 'new000',
        state: 'OPEN',
        statusCheckRollup: [{ name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
      stderr: '',
    }),
  };

  const result = await fetchPrCiStatus(1301, '/repo', deps, { expectedHeadSha: 'new000', requireChecks: true });

  assert.equal(result.conclusion, 'pass');
  assert.equal(result.headSha, 'new000');
  assert.equal(result.readError, undefined);
});

test('fetchPrCiStatus treats a missing headRefOid as a head mismatch when a head is expected', async () => {
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => undefined,
    getIntegrationRequiredChecks: () => [],
    execFile: async () => ({
      stdout: JSON.stringify({
        state: 'OPEN',
        statusCheckRollup: [{ name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
      stderr: '',
    }),
  };

  const result = await fetchPrCiStatus(1301, '/repo', deps, { expectedHeadSha: 'new000' });

  assert.equal(result.conclusion, 'pending');
  assert.equal(result.readError?.errorType, 'head-mismatch');
  assert.match(result.readError?.reason ?? '', /unknown/);
});

test('a cancelled check on the current head fails and names the required context (REQ-F5)', async () => {
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => undefined,
    getIntegrationRequiredChecks: () => ['Shell and Unit Tests'],
    execFile: async () => ({
      stdout: JSON.stringify({
        headRefOid: 'cur000',
        state: 'OPEN',
        statusCheckRollup: [{ name: 'Shell and Unit Tests', status: 'COMPLETED', conclusion: 'CANCELLED' }],
      }),
      stderr: '',
    }),
  };

  const result = await fetchPrCiStatus(1301, '/repo', deps, { expectedHeadSha: 'cur000', requireChecks: true });

  assert.equal(result.conclusion, 'fail');
  assert.deepEqual(result.failing, ['Shell and Unit Tests']);
});

test('no checks reported on the expected head remains pending', async () => {
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => undefined,
    getIntegrationRequiredChecks: () => ['Shell and Unit Tests'],
    execFile: async () => ({
      stdout: JSON.stringify({ headRefOid: 'cur000', state: 'OPEN', statusCheckRollup: [] }),
      stderr: '',
    }),
  };

  const result = await fetchPrCiStatus(1301, '/repo', deps, { expectedHeadSha: 'cur000', requireChecks: true });

  assert.equal(result.conclusion, 'pending');
});

test('fetchPrCiStatus evaluates in-progress rollup as pending', async () => {
  const deps: Partial<PrCiStatusDeps> = {
    resolveOwnerRepo: () => undefined,
    getIntegrationRequiredChecks: () => ['Shell and Unit Tests'],
    execFile: async () => ({
      stdout: JSON.stringify({
        headRefOid: 'abc123',
        state: 'OPEN',
        mergeStateStatus: 'UNKNOWN',
        statusCheckRollup: [{ name: 'Shell and Unit Tests', status: 'IN_PROGRESS', conclusion: null }],
      }),
      stderr: '',
    }),
  };

  const result = await fetchPrCiStatus(1186, '/repo', deps);
  assert.equal(result.conclusion, 'pending');
  assert.equal(result.headSha, 'abc123');
  assert.deepEqual(result.pending, ['Shell and Unit Tests']);
});

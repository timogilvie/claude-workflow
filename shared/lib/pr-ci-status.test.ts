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

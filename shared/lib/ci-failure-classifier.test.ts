import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCiFailure, truncateCiLogExcerpt } from './ci-failure-classifier.ts';

test('classifies known test jobs as deterministic local with command', () => {
  const result = classifyCiFailure({
    checkName: 'Unit Tests',
    conclusion: 'FAILURE',
  });

  assert.equal(result.category, 'deterministic_local');
  assert.equal(result.localCommand, 'npm test');
});

test('uses explicit local command when provided', () => {
  const result = classifyCiFailure({
    checkName: 'lint',
    conclusion: 'FAILURE',
    repositoryContext: { localTestCommand: 'npm run lint -- --fix=false' },
  });

  assert.equal(result.category, 'deterministic_local');
  assert.equal(result.localCommand, 'npm run lint -- --fix=false');
});

test('classifies runner/provider signatures as transient', () => {
  const result = classifyCiFailure({
    checkName: 'build',
    conclusion: 'TIMED_OUT',
    logExcerpt: 'The runner lost communication with GitHub Actions.',
  });

  assert.equal(result.category, 'transient_infra');
  assert.match(result.reason, /runner lost communication/);
});

test('classifies approval and security gates as GitHub-only', () => {
  const approval = classifyCiFailure({
    checkName: 'Required approval',
    conclusion: 'ACTION_REQUIRED',
  });
  const security = classifyCiFailure({
    checkName: 'CodeQL security scan',
    conclusion: 'FAILURE',
  });

  assert.equal(approval.category, 'github_only');
  assert.equal(security.category, 'github_only');
});

test('prefers GitHub-only and transient signatures over deterministic job names', () => {
  const approval = classifyCiFailure({
    checkName: 'Unit Tests approval',
    conclusion: 'FAILURE',
  });
  const transient = classifyCiFailure({
    checkName: 'Unit Tests',
    conclusion: 'FAILURE',
    logExcerpt: 'HTTP 503 server error from actions provider',
  });

  assert.equal(approval.category, 'github_only');
  assert.equal(transient.category, 'transient_infra');
});

test('returns unknown for garbage input without throwing', () => {
  const result = classifyCiFailure({
    checkName: '',
    conclusion: '',
    logExcerpt: '\0\0\0',
  });

  assert.equal(result.category, 'unknown');
});

test('truncates log excerpt to a byte limit and keeps the tail', () => {
  const excerpt = `${'a'.repeat(100)}TAIL`;
  const result = truncateCiLogExcerpt(excerpt, 48);

  assert.ok(result);
  assert.ok(Buffer.byteLength(result, 'utf-8') <= 48);
  assert.match(result, /^\[truncated: showing last CI log bytes\]/);
  assert.match(result, /TAIL$/);
});

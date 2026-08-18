import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  describeSeamArtifactContract,
  listSeamArtifacts,
  validateSeamArtifactContent,
} from './seam-artifacts.ts';

const validBlockedCompletion = {
  stage: 'coding',
  implementationComplete: true,
  committed: true,
  passingChecks: ['node --test shared/lib/seam-artifacts.test.ts'],
  blockingChecks: ['npm test'],
  blockingReason: 'baseline_tests_failing',
  evidence: 'Scoped tests passed; repo-level failures are unrelated.',
  recommendedAction: 'advance_to_review',
};

test('registry covers json and touch seam artifacts', () => {
  assert.deepEqual(
    listSeamArtifacts().map((spec) => [spec.name, spec.filename, spec.kind]),
    [
      ['coding-complete', '.coding-complete', 'json'],
      ['blocked-completion', '.coding-blocked-completion.json', 'json'],
      ['planning-rejected', '.planning-rejected.json', 'json'],
      ['stage-result', '.{stage}-result.json', 'json'],
      ['plan-approved', '.plan-approved', 'touch'],
      ['workflow-aborted', '.workflow-aborted', 'touch'],
      ['migration-detected', '.migration-detected', 'touch'],
    ],
  );
});

test('coding-complete accepts JSON and legacy key=value with canonical JSON output', () => {
  const json = validateSeamArtifactContent('coding-complete', '{"stage":"coding","confidence":"high"}\n');
  assert.equal(json.ok, true);
  if (json.ok) {
    assert.equal(json.changed, true);
    assert.equal(json.value.confidence, 'high');
    assert.equal(json.canonicalContent, '{\n  "stage": "coding",\n  "confidence": "high"\n}\n');
  }

  const legacy = validateSeamArtifactContent('coding-complete', 'confidence=medium\ncommit=abc1234\n');
  assert.equal(legacy.ok, true);
  if (legacy.ok) {
    assert.equal(legacy.changed, true);
    assert.match(legacy.warnings.join('\n'), /key=value/);
    assert.deepEqual(legacy.value, {
      stage: 'coding',
      confidence: 'medium',
      commit: 'abc1234',
    });
  }
});

test('coding-complete rejects empty, array-root, and bad confidence content', () => {
  for (const [raw, expected] of [
    ['', { code: 'MALFORMED_JSON', path: '$' }],
    ['[]', { code: 'INVALID_FIELD_TYPE', path: '$' }],
    ['{"stage":"coding","confidence":"HIGH"}', { code: 'INVALID_ENUM_VALUE', path: '$.confidence' }],
    ['{}', { code: 'MISSING_REQUIRED_FIELD', path: '$.stage' }],
  ] as const) {
    const result = validateSeamArtifactContent('coding-complete', raw);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        { code: result.errors[0]?.code, path: result.errors[0]?.path },
        expected,
      );
    }
  }
});

test('blocked-completion rejects known out-of-enum incident values', () => {
  for (const blockingReason of [
    'environment_or_baseline_tests_failing',
    'environmental_and_baseline_collection_failures',
  ]) {
    const result = validateSeamArtifactContent('blocked-completion', JSON.stringify({
      ...validBlockedCompletion,
      blockingReason,
    }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.errors.map((error) => ({ code: error.code, path: error.path })),
        [{ code: 'INVALID_ENUM_VALUE', path: '$.blockingReason' }],
      );
    }
  }
});

test('blocked-completion handles no verification evidence with optional coercion', () => {
  const raw = JSON.stringify({
    ...validBlockedCompletion,
    passingChecks: [],
  });
  const strict = validateSeamArtifactContent('blocked-completion', raw);
  assert.equal(strict.ok, false);
  if (!strict.ok) {
    assert.deepEqual(strict.errors.map((error) => ({ code: error.code, path: error.path })), [
      { code: 'NO_VERIFICATION_EVIDENCE', path: '$.passingChecks' },
    ]);
  }

  const coerced = validateSeamArtifactContent('blocked-completion', raw, { coerceUnverifiedClaim: true });
  assert.equal(coerced.ok, true);
  if (coerced.ok) {
    assert.equal(coerced.value.implementationComplete, false);
    assert.equal(coerced.changed, true);
  }
});

test('capacity blocked completion validates', () => {
  const result = validateSeamArtifactContent('blocked-completion', JSON.stringify({
    ...validBlockedCompletion,
    implementationComplete: false,
    passingChecks: [],
    blockingReason: 'model_at_capacity',
    recommendedAction: 'relaunch_coding',
  }));
  assert.equal(result.ok, true);
});

test('contract descriptions include relevant enum values', () => {
  const coding = describeSeamArtifactContract('coding-complete');
  assert.match(coding, /"stage"/);
  for (const value of ['high', 'medium', 'low']) assert.match(coding, new RegExp(value));

  const blocked = describeSeamArtifactContract('blocked-completion');
  for (const value of ['repo_verification_blocked', 'environment_blocked', 'baseline_tests_failing', 'advance_to_review']) {
    assert.match(blocked, new RegExp(value));
  }
});

test('agent-facing prompts mention seam contract fields and enums', () => {
  const codingPrompt = readFileSync('tools/prompts/coding-phase.md', 'utf-8');
  const adapters = readFileSync('shared/lib/agent-adapters.sh', 'utf-8');
  const combined = `${codingPrompt}\n${adapters}`;

  for (const token of [
    '"stage"',
    '"confidence"',
    'high',
    'medium',
    'low',
    'repo_verification_blocked',
    'environment_blocked',
    'baseline_tests_failing',
    'advance_to_review',
  ]) {
    assert.match(combined, new RegExp(escapeRegExp(token)));
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

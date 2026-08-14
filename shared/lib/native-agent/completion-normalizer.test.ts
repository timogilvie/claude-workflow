import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coerceUnverifiedCompletionClaim,
  hasVerificationEvidence,
} from '../blocked-completion.ts';
import {
  normalizeBlockedCompletionContent,
  normalizeCodingCompleteContent,
  parseLenientObject,
} from './completion-normalizer.ts';

const validBlockedCompletion = {
  stage: 'coding',
  implementationComplete: true,
  committed: true,
  commit: 'abc1234',
  passingChecks: ['node --test shared/lib/example.test.ts'],
  blockingChecks: ['npm test'],
  blockingReason: 'baseline_tests_failing',
  evidence: 'Scoped tests passed; repo-level failures are unrelated.',
  recommendedAction: 'advance_to_review',
};

test('normalizes JSON object written as .coding-complete to key=value', () => {
  const result = normalizeCodingCompleteContent(JSON.stringify({
    confidence: 'high',
    commit: 'abc1234',
    attempts: 2,
  }));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, true);
    assert.equal(result.canonicalContent, 'confidence=high\nattempts=2\ncommit=abc1234\n');
    assert.match(result.warnings.join('\n'), /normalized json payload/);
  }
});

test('passes canonical .coding-complete through unchanged', () => {
  const input = 'confidence=medium\ncommit=abc1234\n';
  const result = normalizeCodingCompleteContent(input);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, false);
    assert.equal(result.canonicalContent, input);
  }
});

test('normalizes flat YAML blocked completion to canonical JSON', () => {
  const result = normalizeBlockedCompletionContent(`
stage: coding
implementationComplete: true
committed: true
commit: abc1234
passingChecks:
  - node --test shared/lib/example.test.ts
blockingChecks: [npm test]
blockingReason: baseline_tests_failing
evidence: Scoped tests passed.
recommendedAction: advance_to_review
`);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, true);
    assert.equal(result.value.passingChecks[0], 'node --test shared/lib/example.test.ts');
    assert.equal(JSON.parse(result.canonicalContent).stage, 'coding');
    assert.match(result.warnings.join('\n'), /normalized yaml payload/);
  }
});

test('accepts fenced JSON payloads', () => {
  const result = parseLenientObject(`\`\`\`json
${JSON.stringify(validBlockedCompletion)}
\`\`\``);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sourceFormat, 'fenced-json');
    assert.equal(result.value.stage, 'coding');
  }
});

test('accepts flow-sequence YAML arrays', () => {
  const result = parseLenientObject('passingChecks: [a, "b c"]\nblockingChecks: []\n');

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.passingChecks, ['a', 'b c']);
    assert.deepEqual(result.value.blockingChecks, []);
  }
});

test('fails closed for nested YAML, prose, and empty input', () => {
  assert.deepEqual(parseLenientObject('outer:\n  nested: value\n'), { ok: false });
  assert.deepEqual(parseLenientObject('this is not an artifact'), { ok: false });
  assert.deepEqual(parseLenientObject(''), { ok: false });
});

test('normalizes canonical blocked completion without byte change unless coercing', () => {
  const input = `${JSON.stringify(validBlockedCompletion, null, 2)}\n`;
  const result = normalizeBlockedCompletionContent(input);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, false);
    assert.equal(result.canonicalContent, input);
  }
});

test('evidence helpers coerce unverified completion claims only', () => {
  const unverified = {
    ...validBlockedCompletion,
    passingChecks: [],
  };
  assert.equal(hasVerificationEvidence(unverified), false);
  assert.deepEqual(coerceUnverifiedCompletionClaim(unverified), {
    value: {
      ...unverified,
      implementationComplete: false,
    },
    coerced: true,
  });

  assert.equal(hasVerificationEvidence(validBlockedCompletion), true);
  assert.equal(coerceUnverifiedCompletionClaim(validBlockedCompletion).coerced, false);
  assert.equal(coerceUnverifiedCompletionClaim({
    ...unverified,
    implementationComplete: false,
  }).coerced, false);
});


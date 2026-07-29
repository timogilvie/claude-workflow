import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendChallengeComparison,
  buildInvalidChallengeComparison,
  buildSkippedIdenticalComparison,
  listVariedRoutingDimensions,
  readChallengeComparisons,
  detectVariedDimensions,
  hasAnyVariedDimension,
  classifyChallengeType,
  type ChallengeComparison,
  type ChallengeRoutingMeta,
} from './challenge-comparison.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

function makeRecord(overrides?: Partial<ChallengeComparison>): ChallengeComparison {
  return {
    challengePairId: 'HOK-970',
    primaryModel: 'claude-sonnet-4-5-20250929',
    challengerModel: 'claude-opus-4-6',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.9,
    winner: 'challenger',
    winnerModel: 'claude-opus-4-6',
    rationale: 'Challenger is more complete.',
    dimensions: {
      completeness: { primary: 7, challenger: 9 },
      correctness: { primary: 7, challenger: 9 },
      code_quality: { primary: 7, challenger: 8 },
      intervention_impact: { primary: 8, challenger: 8 },
      autonomy: { primary: 7, challenger: 9 },
    },
    timestamp: '2026-03-09T12:00:00Z',
    ...overrides,
  };
}

console.log('\n--- Challenge Comparison Persistence Tests ---\n');

test('appendChallengeComparison writes a record that can be read back', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-comparison-test-'));
  try {
    appendChallengeComparison(makeRecord(), tmp);
    const records = readChallengeComparisons(tmp);
    assert.equal(records.length, 1);
    assert.equal(records[0].challengePairId, 'HOK-970');
    assert.equal(records[0].winner, 'challenger');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readChallengeComparisons returns empty array when file is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-comparison-test-'));
  try {
    const records = readChallengeComparisons(tmp);
    assert.deepEqual(records, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log('\n--- Dimension Detection Tests ---\n');

function makeRouting(overrides?: Partial<ChallengeRoutingMeta>): ChallengeRoutingMeta {
  return {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-5-20250929',
    reviewer: 'claude-sonnet-4-5-20250929',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'strict',
    routerVariant: 'baseline',
    plannerPromptVariant: 'baseline',
    reviewerPromptVariant: 'baseline',
    ...overrides,
  };
}

test('detectVariedDimensions returns undefined when primary routing is missing', () => {
  const result = detectVariedDimensions(undefined, makeRouting());
  assert.equal(result, undefined);
});

test('detectVariedDimensions returns undefined when challenger routing is missing', () => {
  const result = detectVariedDimensions(makeRouting(), undefined);
  assert.equal(result, undefined);
});

test('detectVariedDimensions returns all false when routings are identical', () => {
  const routing = makeRouting();
  const result = detectVariedDimensions(routing, routing);
  assert.ok(result);
  assert.equal(result.planner, false);
  assert.equal(result.coder, false);
  assert.equal(result.reviewer, false);
  assert.equal(result.planDepth, false);
  assert.equal(result.codeDepth, false);
  assert.equal(result.reviewMode, false);
  assert.equal(result.routerVariant, false);
  assert.equal(result.plannerPromptVariant, false);
  assert.equal(result.reviewerPromptVariant, false);
});

test('detectVariedDimensions detects single field difference (coder)', () => {
  const primary = makeRouting();
  const challenger = makeRouting({ coder: 'claude-haiku-4-5-20251001' });
  const result = detectVariedDimensions(primary, challenger);
  assert.ok(result);
  assert.equal(result.planner, false);
  assert.equal(result.coder, true);
  assert.equal(result.reviewer, false);
  assert.equal(result.planDepth, false);
  assert.equal(result.codeDepth, false);
  assert.equal(result.reviewMode, false);
  assert.equal(result.routerVariant, false);
  assert.equal(result.plannerPromptVariant, false);
  assert.equal(result.reviewerPromptVariant, false);
});

test('detectVariedDimensions detects multiple field differences', () => {
  const primary = makeRouting();
  const challenger = makeRouting({
    planner: 'claude-sonnet-4-5-20250929',
    codeDepth: 'shallow',
    routerVariant: 'optimized',
  });
  const result = detectVariedDimensions(primary, challenger);
  assert.ok(result);
  assert.equal(result.planner, true);
  assert.equal(result.coder, false);
  assert.equal(result.reviewer, false);
  assert.equal(result.planDepth, false);
  assert.equal(result.codeDepth, true);
  assert.equal(result.reviewMode, false);
  assert.equal(result.routerVariant, true);
});

test('detectVariedDimensions treats empty strings as equivalent', () => {
  const primary = makeRouting({ reviewer: '' });
  const challenger = makeRouting({ reviewer: '' });
  const result = detectVariedDimensions(primary, challenger);
  assert.ok(result);
  assert.equal(result.reviewer, false);
  assert.equal(result.reviewerPromptVariant, false);
});

test('listVariedRoutingDimensions reports no launchable differences for identical HOK-2297 routing', () => {
  const routing = makeRouting({
    planner: 'claude-opus-4-7',
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-7',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  });
  assert.deepEqual(listVariedRoutingDimensions(routing, routing), []);
});

test('listVariedRoutingDimensions reports no launchable differences for identical HOK-2298 routing', () => {
  const routing = makeRouting({
    planner: 'gpt-5.5',
    coder: 'claude-sonnet-4-6',
    reviewer: 'gpt-5.5',
    planDepth: 'medium',
    codeDepth: 'medium',
    reviewMode: 'llm',
  });
  assert.deepEqual(listVariedRoutingDimensions(routing, routing), []);
});

test('listVariedRoutingDimensions reports each canonical launch dimension', () => {
  const primary = makeRouting();
  assert.deepEqual(
    listVariedRoutingDimensions(primary, makeRouting({
      planner: 'other-planner',
      coder: 'other-coder',
      reviewer: 'other-reviewer',
      planDepth: 'light',
      codeDepth: 'deep',
      reviewMode: 'llm',
    })),
    ['planner', 'coder', 'reviewer', 'planDepth', 'codeDepth', 'reviewMode'],
  );
});

console.log('\n--- Challenge Type Classification Tests ---\n');

test('classifyChallengeType returns "coder-only" when only coder differs', () => {
  const varied = {
    planner: false,
    coder: true,
    reviewer: false,
    planDepth: false,
    codeDepth: false,
    reviewMode: false,
    routerVariant: false,
    plannerPromptVariant: false,
    reviewerPromptVariant: false,
  };
  const result = classifyChallengeType(varied);
  assert.equal(result, 'coder-only');
});

test('classifyChallengeType returns "planner-only" when only planner differs', () => {
  const varied = {
    planner: true,
    coder: false,
    reviewer: false,
    planDepth: false,
    codeDepth: false,
    reviewMode: false,
    routerVariant: false,
    plannerPromptVariant: false,
    reviewerPromptVariant: false,
  };
  const result = classifyChallengeType(varied);
  assert.equal(result, 'planner-only');
});

test('classifyChallengeType returns "reviewer-only" when only reviewer differs', () => {
  const varied = {
    planner: false,
    coder: false,
    reviewer: true,
    planDepth: false,
    codeDepth: false,
    reviewMode: false,
    routerVariant: false,
    plannerPromptVariant: false,
    reviewerPromptVariant: false,
  };
  const result = classifyChallengeType(varied);
  assert.equal(result, 'reviewer-only');
});

test('classifyChallengeType returns "full-stack" when all dimensions differ', () => {
  const varied = {
    planner: true,
    coder: true,
    reviewer: true,
    planDepth: true,
    codeDepth: true,
    reviewMode: true,
    routerVariant: true,
    plannerPromptVariant: true,
    reviewerPromptVariant: true,
  };
  const result = classifyChallengeType(varied);
  assert.equal(result, 'full-stack');
});

test('classifyChallengeType returns "multi-variable" when coder and planDepth differ', () => {
  const varied = {
    planner: false,
    coder: true,
    reviewer: false,
    planDepth: true,
    codeDepth: false,
    reviewMode: false,
    routerVariant: false,
    plannerPromptVariant: false,
    reviewerPromptVariant: false,
  };
  const result = classifyChallengeType(varied);
  assert.equal(result, 'multi-variable');
});

test('classifyChallengeType returns "multi-variable" when only depth fields differ', () => {
  const varied = {
    planner: false,
    coder: false,
    reviewer: false,
    planDepth: true,
    codeDepth: true,
    reviewMode: false,
  };
  const result = classifyChallengeType(varied);
  assert.equal(result, 'multi-variable');
});

test('classifyChallengeType rejects records with no varied dimensions', () => {
  const varied = {
    planner: false,
    coder: false,
    reviewer: false,
    planDepth: false,
    codeDepth: false,
    reviewMode: false,
    routerVariant: false,
    plannerPromptVariant: false,
    reviewerPromptVariant: false,
  };
  assert.equal(hasAnyVariedDimension(varied), false);
  assert.throws(
    () => classifyChallengeType(varied),
    /no routing dimensions varied/,
  );
});

console.log('\n--- Routing Persistence Tests ---\n');

test('record with routing metadata round-trips correctly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-comparison-test-'));
  try {
    const record = makeRecord({
      primaryRouting: makeRouting(),
      challengerRouting: makeRouting({ coder: 'claude-haiku-4-5-20251001' }),
      variedDimensions: {
        planner: false,
        coder: true,
        reviewer: false,
        planDepth: false,
        codeDepth: false,
        reviewMode: false,
      },
      challengeType: 'coder-only',
      workflowInsight: 'The coder model difference led to different implementation patterns.',
    });
    appendChallengeComparison(record, tmp);
    const records = readChallengeComparisons(tmp);
    assert.equal(records.length, 1);
    assert.ok(records[0].primaryRouting);
    assert.equal(records[0].primaryRouting?.coder, 'claude-sonnet-4-5-20250929');
    assert.ok(records[0].challengerRouting);
    assert.equal(records[0].challengerRouting?.coder, 'claude-haiku-4-5-20251001');
    assert.ok(records[0].variedDimensions);
    assert.equal(records[0].variedDimensions?.coder, true);
    assert.equal(records[0].challengeType, 'coder-only');
    assert.equal(records[0].workflowInsight, 'The coder model difference led to different implementation patterns.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('record without routing metadata (old format) parses correctly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-comparison-test-'));
  try {
    const record = makeRecord(); // No routing fields
    appendChallengeComparison(record, tmp);
    const records = readChallengeComparisons(tmp);
    assert.equal(records.length, 1);
    assert.equal(records[0].primaryRouting, undefined);
    assert.equal(records[0].challengerRouting, undefined);
    assert.equal(records[0].variedDimensions, undefined);
    assert.equal(records[0].challengeType, undefined);
    assert.equal(records[0].workflowInsight, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildSkippedIdenticalComparison returns deterministic primary-wins metadata', () => {
  const record = buildSkippedIdenticalComparison({
    challengePairId: 'HOK-2301',
    primaryModel: 'gpt-5.4',
    challengerModel: 'gpt-5.4',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.7,
    challengerEvalScore: 0.7,
    primaryRouting: makeRouting({
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-7',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
    }),
    challengerRouting: makeRouting({
      planner: 'claude-opus-4-7',
      coder: 'gpt-5.4',
      reviewer: 'claude-opus-4-7',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'llm',
    }),
    timestamp: '2026-06-23T12:00:00.000Z',
  });

  assert.equal(record.winner, 'primary');
  assert.equal(record.comparisonOutcome, 'skipped');
  assert.equal(record.skipReason, 'identical-routing-dimensions');
  assert.equal(record.cleanupPolicy, 'primary-wins-close-challenger');
  assert.equal(record.challengeType, undefined);
  assert.equal(record.workflowInsight, 'No LLM comparison was run because both workflows resolved to identical routing dimensions.');
});

test('buildInvalidChallengeComparison omits winner and cleanup policy', () => {
  const record = buildInvalidChallengeComparison({
    challengePairId: 'HOK-2575',
    primaryModel: 'gpt-5.5',
    challengerModel: 'glm-5.2',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.8,
    reason: 'stage_override_lost',
    details: 'Expected review model glm-5.2, effective route has gpt-5.5.',
  });

  assert.equal(record.comparisonOutcome, 'invalid_challenge');
  assert.equal(record.invalidChallenge, true);
  assert.equal(record.invalidChallengeReason, 'stage_override_lost');
  assert.equal(record.winner, undefined);
  assert.equal(record.winnerModel, undefined);
  assert.equal(record.cleanupPolicy, undefined);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});

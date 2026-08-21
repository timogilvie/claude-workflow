import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendChallengeComparison,
  buildDoubleForfeitComparison,
  buildForfeitComparison,
  buildInvalidChallengeComparison,
  buildSkippedIdenticalComparison,
  buildInvalidProvenanceComparison,
  listVariedRoutingDimensions,
  readChallengeComparisons,
  detectVariedDimensions,
  hasAnyVariedDimension,
  classifyChallengeType,
  resolveChallengeSideExecutionProvenance,
  validateChallengeExecutionProvenance,
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

console.log('\n--- Execution Provenance Tests ---\n');

function writeStage(featureDir: string, stage: 'planning' | 'coding' | 'review', agent: string, model: string, status = 'completed') {
  writeFileSync(
    join(featureDir, `.${stage}-result.json`),
    JSON.stringify({
      stage,
      status,
      startedAt: '2026-07-29T00:00:00Z',
      finishedAt: '2026-07-29T00:01:00Z',
      agent,
      model,
      notes: '',
    }),
  );
}

test('resolver canonicalizes native OpenRouter Kimi planner provenance and preserves artifact path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-provenance-test-'));
  try {
    const featureDir = join(tmp, 'features', 'hok-2578');
    mkdirSync(featureDir, { recursive: true });
    writeStage(featureDir, 'planning', 'native-openrouter', 'moonshotai/kimi-k2.7-code');
    writeStage(featureDir, 'coding', 'claude', 'claude-sonnet-5');
    writeStage(featureDir, 'review', 'claude', 'claude-opus-4-7');

    const resolved = resolveChallengeSideExecutionProvenance({ featureDir });

    assert.equal(resolved.planning.agent, 'native-openrouter');
    assert.equal(resolved.planning.model, 'kimi-k2.7-code');
    assert.equal(resolved.planning.rawModel, 'moonshotai/kimi-k2.7-code');
    assert.equal(resolved.planning.status, 'completed');
    assert.equal(resolved.planning.source, '.planning-result.json');
    assert.match(resolved.planning.artifactPath || '', /\.planning-result\.json$/);
    assert.deepEqual(resolved.planning.consultedArtifactPaths, [join(featureDir, '.planning-result.json')]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('planner intent mismatch with native Kimi execution invalidates challenged stage', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-provenance-test-'));
  try {
    const primaryDir = join(tmp, 'features', 'primary');
    const challengerDir = join(tmp, 'features', 'challenger');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(challengerDir, { recursive: true });
    writeStage(primaryDir, 'planning', 'native-openrouter', 'moonshotai/kimi-k2.7-code');
    writeStage(challengerDir, 'planning', 'claude', 'claude-sonnet-5');

    const primaryRouting = makeRouting({ planner: 'claude-opus-4-7' });
    const challengerRouting = makeRouting({ planner: 'claude-sonnet-5' });
    const variedDimensions = detectVariedDimensions(primaryRouting, challengerRouting);
    const primaryExecution = resolveChallengeSideExecutionProvenance({ featureDir: primaryDir });
    const challengerExecution = resolveChallengeSideExecutionProvenance({ featureDir: challengerDir });
    const validation = validateChallengeExecutionProvenance({
      primaryExecution,
      challengerExecution,
      primaryRouting,
      challengerRouting,
      primaryModel: primaryRouting.coder,
      challengerModel: challengerRouting.coder,
      variedDimensions,
    });

    assert.equal(validation.valid, false);
    assert.equal(validation.outcome, 'invalid');
    assert.equal(validation.challengedStage, 'planning');
    assert.equal(validation.issues[0].side, 'primary');
    assert.equal(validation.issues[0].reason, 'executed-model-mismatch');
    assert.equal(validation.issues[0].intendedModel, 'claude-opus-4-7');
    assert.equal(validation.issues[0].executedModel, 'kimi-k2.7-code');
    assert.match(validation.issues[0].artifactPath || '', /\.planning-result\.json$/);

    const record = buildInvalidProvenanceComparison({
      challengePairId: 'HOK-2578',
      primaryModel: primaryRouting.coder,
      challengerModel: challengerRouting.coder,
      primaryPrUrl: 'https://github.com/org/repo/pull/1',
      challengerPrUrl: 'https://github.com/org/repo/pull/2',
      primaryEvalScore: 0.8,
      challengerEvalScore: 0.8,
      primaryRouting,
      challengerRouting,
      primaryExecution,
      challengerExecution,
      provenanceValidation: validation,
      variedDimensions,
      challengeType: 'planner-only',
      variedStage: 'plan',
    });
    assert.equal(record.comparisonOutcome, 'invalid');
    assert.equal(record.winner, undefined);
    assert.equal(record.winnerModel, undefined);
    assert.equal(record.terminalReason, 'provenance_validation_failed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('same intended routing with different execution is inconclusive', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-provenance-test-'));
  try {
    const primaryDir = join(tmp, 'features', 'primary');
    const challengerDir = join(tmp, 'features', 'challenger');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(challengerDir, { recursive: true });
    writeStage(primaryDir, 'planning', 'claude', 'claude-opus-4-7');
    writeStage(challengerDir, 'planning', 'native-openrouter', 'moonshotai/kimi-k2.7-code');

    const routing = makeRouting({ planner: 'claude-opus-4-7' });
    const variedDimensions = detectVariedDimensions(routing, routing);
    const validation = validateChallengeExecutionProvenance({
      primaryExecution: resolveChallengeSideExecutionProvenance({ featureDir: primaryDir }),
      challengerExecution: resolveChallengeSideExecutionProvenance({ featureDir: challengerDir }),
      primaryRouting: routing,
      challengerRouting: routing,
      primaryModel: routing.coder,
      challengerModel: routing.coder,
      variedDimensions,
    });

    assert.equal(validation.valid, false);
    assert.equal(validation.outcome, 'inconclusive');
    assert.equal(validation.issues[0].reason, 'same-intent-different-execution');
    assert.equal(validation.issues[0].stage, 'planning');
    assert.match(validation.issues[0].executedModel || '', /primary=claude-opus-4-7; challenger=kimi-k2\.7-code/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('forfeit builders use null scores and explicit completion metadata', () => {
  const forfeit = buildForfeitComparison({
    challengePairId: 'HOK-2778',
    primaryModel: 'gpt-5.5',
    challengerModel: 'qwen-2.5-coder-32b',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/unknown/unknown/pull/0',
    winner: 'primary',
    rationale: 'Challenger failed.',
    terminalReason: 'challenger_challenge_aborted',
    challengerCompleted: false,
    armFailures: [{
      side: 'challenger',
      model: 'qwen-2.5-coder-32b',
      stage: 'coding',
      failureKind: 'tool-use-unsupported',
      faultClass: 'selection-fault',
    }],
  });
  assert.equal(forfeit.primaryEvalScore, null);
  assert.equal(forfeit.challengerEvalScore, null);
  assert.equal(forfeit.primaryCompleted, true);
  assert.equal(forfeit.challengerCompleted, false);
  assert.equal(forfeit.armFailures?.[0].faultClass, 'selection-fault');

  const doubleForfeit = buildDoubleForfeitComparison({
    challengePairId: 'HOK-2778',
    primaryModel: 'kimi-k2',
    challengerModel: 'glm-5.2',
    primaryPrUrl: 'https://github.com/unknown/unknown/pull/0',
    challengerPrUrl: 'https://github.com/unknown/unknown/pull/0',
    rationale: 'Both failed.',
    terminalReason: 'both_challenge_aborted',
  });
  assert.equal(doubleForfeit.primaryEvalScore, null);
  assert.equal(doubleForfeit.challengerEvalScore, null);
  assert.equal(doubleForfeit.primaryCompleted, false);
  assert.equal(doubleForfeit.challengerCompleted, false);
});

// ────────────────────────────────────────────────────────────────
// P0.5 Phase 0 Fork Descriptor Fields Tests (HOK-2794)
// ────────────────────────────────────────────────────────────────

test('buildInvalidProvenanceComparison emits fork descriptor fields with empty defaults', () => {
  const record = buildInvalidProvenanceComparison({
    challengePairId: 'HOK-2794',
    primaryModel: 'claude-opus-4-6',
    challengerModel: 'claude-sonnet-4-5-20250929',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.5,
    challengerEvalScore: 0.5,
    primaryExecution: resolveChallengeSideExecutionProvenance({ featureDir: undefined, repoDir: undefined }),
    challengerExecution: resolveChallengeSideExecutionProvenance({ featureDir: undefined, repoDir: undefined }),
    provenanceValidation: {
      valid: false,
      outcome: 'invalid',
      issues: [],
    },
  });
  assert.equal(record.forkStage, null);
  assert.equal(record.forkCommit, null);
  assert.equal(record.sharedPrefix, false);
  assert.deepEqual(record.primaryInheritedStages, []);
  assert.deepEqual(record.challengerInheritedStages, []);
});

test('buildSkippedIdenticalComparison emits fork descriptor fields with empty defaults', () => {
  const record = buildSkippedIdenticalComparison({
    challengePairId: 'HOK-2794',
    primaryModel: 'claude-opus-4-6',
    challengerModel: 'claude-sonnet-4-5-20250929',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.8,
  });
  assert.equal(record.forkStage, null);
  assert.equal(record.forkCommit, null);
  assert.equal(record.sharedPrefix, false);
  assert.deepEqual(record.primaryInheritedStages, []);
  assert.deepEqual(record.challengerInheritedStages, []);
});

test('buildInvalidChallengeComparison emits fork descriptor fields with empty defaults', () => {
  const record = buildInvalidChallengeComparison({
    challengePairId: 'HOK-2794',
    primaryModel: 'claude-opus-4-6',
    challengerModel: 'claude-sonnet-4-5-20250929',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.8,
    reason: 'identical_effective_route',
  });
  assert.equal(record.forkStage, null);
  assert.equal(record.forkCommit, null);
  assert.equal(record.sharedPrefix, false);
  assert.deepEqual(record.primaryInheritedStages, []);
  assert.deepEqual(record.challengerInheritedStages, []);
});

test('buildForfeitComparison emits fork descriptor fields with empty defaults', () => {
  const record = buildForfeitComparison({
    challengePairId: 'HOK-2794',
    primaryModel: 'claude-opus-4-6',
    challengerModel: 'claude-sonnet-4-5-20250929',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    winner: 'primary',
    rationale: 'Challenger failed.',
    terminalReason: 'challenger_challenge_aborted',
  });
  assert.equal(record.forkStage, null);
  assert.equal(record.forkCommit, null);
  assert.equal(record.sharedPrefix, false);
  assert.deepEqual(record.primaryInheritedStages, []);
  assert.deepEqual(record.challengerInheritedStages, []);
});

test('buildDoubleForfeitComparison emits fork descriptor fields with empty defaults', () => {
  const record = buildDoubleForfeitComparison({
    challengePairId: 'HOK-2794',
    primaryModel: 'claude-opus-4-6',
    challengerModel: 'claude-sonnet-4-5-20250929',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    rationale: 'Both failed.',
    terminalReason: 'both_challenge_aborted',
  });
  assert.equal(record.forkStage, null);
  assert.equal(record.forkCommit, null);
  assert.equal(record.sharedPrefix, false);
  assert.deepEqual(record.primaryInheritedStages, []);
  assert.deepEqual(record.challengerInheritedStages, []);
});

test('historical record without fork descriptor fields parses cleanly', () => {
  const historicalRecord: ChallengeComparison = {
    challengePairId: 'HOK-1234',
    primaryModel: 'claude-opus-4-5-20250929',
    challengerModel: 'claude-sonnet-4-5-20250929',
    primaryPrUrl: 'https://github.com/org/repo/pull/100',
    challengerPrUrl: 'https://github.com/org/repo/pull/101',
    primaryEvalScore: 0.7,
    challengerEvalScore: 0.8,
    winner: 'challenger',
    winnerModel: 'claude-sonnet-4-5-20250929',
    rationale: 'Sonnet is better.',
    dimensions: {
      completeness: { primary: 0.7, challenger: 0.8 },
      correctness: { primary: 0.7, challenger: 0.8 },
      code_quality: { primary: 0.7, challenger: 0.8 },
      intervention_impact: { primary: 0.7, challenger: 0.8 },
      autonomy: { primary: 0.7, challenger: 0.8 },
    },
    timestamp: '2024-01-01T00:00:00Z',
  };

  // Should not throw and should parse cleanly
  assert.ok(historicalRecord.challengePairId);
  assert.equal(historicalRecord.forkStage, undefined);
  assert.equal(historicalRecord.forkCommit, undefined);
  assert.equal(historicalRecord.sharedPrefix, undefined);
  assert.equal(historicalRecord.primaryInheritedStages, undefined);
  assert.equal(historicalRecord.challengerInheritedStages, undefined);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});

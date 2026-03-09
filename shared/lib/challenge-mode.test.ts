import assert from 'node:assert/strict';
import {
  canRunChallenge,
  chooseDistinctChallengerModel,
  deriveChallengeBranch,
  deriveChallengeSlug,
  deriveChallengerKey,
  getChallengeModelPool,
  pickChallengeModels,
} from './challenge-mode.ts';

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

console.log('\n--- Challenge Mode Tests ---\n');

test('challenge model pool prefers explicit challenge.models', () => {
  const pool = getChallengeModelPool(
    { models: ['claude-opus-4-6', 'gpt-5.3-codex', 'claude-opus-4-6'] },
    { models: ['claude-sonnet-4-5-20250929'] },
  );
  assert.deepEqual(pool, ['claude-opus-4-6', 'gpt-5.3-codex']);
});

test('challenge model pool falls back to router models when challenge.models is null', () => {
  const pool = getChallengeModelPool(
    { models: null },
    { models: ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex'] },
  );
  assert.deepEqual(pool, ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex']);
});

test('canRunChallenge requires at least two distinct models', () => {
  assert.equal(canRunChallenge(['claude-opus-4-6']), false);
  assert.equal(canRunChallenge(['claude-opus-4-6', 'claude-opus-4-6', 'gpt-5.3-codex']), true);
});

test('derive challenge identifiers and branches', () => {
  assert.equal(deriveChallengerKey('HOK-970'), 'HOK-970__challenger');
  assert.equal(deriveChallengeSlug('feature-name', 'primary'), 'feature-name');
  assert.equal(deriveChallengeSlug('feature-name', 'challenger'), 'feature-name-challenger');
  assert.equal(deriveChallengeBranch('feature-name', 'primary'), 'task/feature-name');
  assert.equal(deriveChallengeBranch('feature-name', 'challenger'), 'task/feature-name-challenger');
});

test('chooseDistinctChallengerModel skips the primary model', () => {
  const challenger = chooseDistinctChallengerModel(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    'claude-opus-4-6',
    () => 0,
  );
  assert.equal(challenger, 'claude-sonnet-4-5-20250929');
});

test('pickChallengeModels uses the router-selected primary model', () => {
  const pair = pickChallengeModels(
    ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-970',
      issueId: 'HOK-970',
      slug: 'challenge-mode',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.3-codex': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0.9,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.primary.agent, 'claude');
  assert.notEqual(pair!.challenger.model, pair!.primary.model);
  assert.equal(pair!.challenger.agent, 'codex');
  assert.equal(pair!.challenger.key, 'HOK-970__challenger');
});

test('pickChallengeModels allows a router-selected primary model outside the configured pool', () => {
  const pair = pickChallengeModels(
    ['claude-sonnet-4-5-20250929', 'gpt-5.3-codex'],
    {
      pairId: 'HOK-971',
      issueId: 'HOK-971',
      slug: 'external-primary',
      primaryModel: 'claude-opus-4-6',
      agentMap: { 'gpt-5.3-codex': 'codex' },
      defaultAgent: 'claude',
      randomFn: () => 0,
    },
  );

  assert.ok(pair);
  assert.equal(pair!.primary.model, 'claude-opus-4-6');
  assert.equal(pair!.challenger.model, 'claude-sonnet-4-5-20250929');
});

test('pickChallengeModels returns null when fewer than two distinct models exist', () => {
  const pair = pickChallengeModels(['claude-opus-4-6'], {
    pairId: 'HOK-970',
    issueId: 'HOK-970',
    slug: 'challenge-mode',
  });
  assert.equal(pair, null);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});

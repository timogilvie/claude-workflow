import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  deriveChallengeSideFromBranch,
  deriveChallengeSideFromState,
  resolveChallengeIntent,
  resolveChallengeSide,
} from './challenge-execution-contract.ts';

let repoDir: string;
let statePath: string;

function writeState(state: unknown): void {
  writeFileSync(statePath, JSON.stringify(state), 'utf-8');
}

describe('deriveChallengeSideFromBranch', () => {
  it('returns undefined when no challenge pair id is present', () => {
    assert.equal(deriveChallengeSideFromBranch('task/hok-2581-fix-thing-challenger', 'HOK-2581', undefined), undefined);
  });

  it('recognizes the actual -challenger branch suffix', () => {
    assert.equal(
      deriveChallengeSideFromBranch('task/hok-2581-fix-thing-challenger', 'HOK-2581', 'HOK-2581'),
      'challenger',
    );
  });

  it('recognizes the legacy _c branch suffix', () => {
    assert.equal(
      deriveChallengeSideFromBranch('task/hok-2581-fix-thing_c', 'HOK-2581', 'HOK-2581'),
      'challenger',
    );
  });

  it('recognizes the legacy _c issue-id suffix', () => {
    assert.equal(
      deriveChallengeSideFromBranch('task/hok-2581-fix-thing', 'HOK-2581_c', 'HOK-2581'),
      'challenger',
    );
  });

  it('falls back to primary when no suffix is present', () => {
    assert.equal(
      deriveChallengeSideFromBranch('task/hok-2581-fix-thing', 'HOK-2581', 'HOK-2581'),
      'primary',
    );
  });
});

describe('canonical state resolution', () => {
  beforeEach(() => {
    repoDir = join(tmpdir(), `challenge-execution-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(repoDir, '.wavemill', 'state'), { recursive: true });
    statePath = join(repoDir, '.wavemill', 'state', 'workflow-state.json');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('deriveChallengeSideFromState reads challengeRole for the issue id', () => {
    writeState({ tasks: { 'HOK-1': { challengeRole: 'challenger' } } });
    assert.equal(deriveChallengeSideFromState(repoDir, 'HOK-1', 'HOK-1'), 'challenger');
  });

  it('deriveChallengeSideFromState returns undefined when state is absent', () => {
    assert.equal(deriveChallengeSideFromState(repoDir, 'HOK-1', 'HOK-1'), undefined);
  });

  it('deriveChallengeSideFromState returns undefined on malformed state', () => {
    writeFileSync(statePath, '{not valid json', 'utf-8');
    assert.equal(deriveChallengeSideFromState(repoDir, 'HOK-1', 'HOK-1'), undefined);
  });

  it('resolveChallengeSide prefers canonical challengeRole over the branch fallback', () => {
    writeState({ tasks: { 'HOK-1': { challengeRole: 'primary' } } });
    const result = resolveChallengeSide({
      repoDir,
      branchName: 'task/hok-1-fix-thing',
      issueId: 'HOK-1',
      challengePairId: 'HOK-1',
    });
    assert.deepEqual(result, { side: 'primary', source: 'state', mismatch: false });
  });

  it('resolveChallengeSide flags a disagreement between state and the branch fallback as a mismatch', () => {
    writeState({ tasks: { 'HOK-1': { challengeRole: 'primary' } } });
    const result = resolveChallengeSide({
      repoDir,
      branchName: 'task/hok-1-fix-thing-challenger',
      issueId: 'HOK-1',
      challengePairId: 'HOK-1_c',
    });
    assert.equal(result.side, 'primary');
    assert.equal(result.source, 'state');
    assert.equal(result.mismatch, true);
  });

  it('resolveChallengeSide falls back to the branch heuristic when state is absent', () => {
    const result = resolveChallengeSide({
      repoDir,
      branchName: 'task/hok-1-fix-thing-challenger',
      issueId: 'HOK-1',
      challengePairId: 'HOK-1',
    });
    assert.deepEqual(result, { side: 'challenger', source: 'branch', mismatch: false });
  });

  it('resolveChallengeSide falls back to the branch heuristic when state is malformed', () => {
    writeFileSync(statePath, '{not valid json', 'utf-8');
    const result = resolveChallengeSide({
      repoDir,
      branchName: 'task/hok-1-fix-thing-challenger',
      issueId: 'HOK-1',
      challengePairId: 'HOK-1',
    });
    assert.deepEqual(result, { side: 'challenger', source: 'branch', mismatch: false });
  });

  it('resolveChallengeSide returns none when there is no challenge pair', () => {
    const result = resolveChallengeSide({ repoDir, branchName: 'task/hok-1-fix-thing', issueId: 'HOK-1' });
    assert.deepEqual(result, { side: undefined, source: 'none', mismatch: false });
  });

  it('resolveChallengeIntent prefers canonical challengeExecutionIntent over the legacy challengeIntent key', () => {
    const canonical = { pairId: 'HOK-1', challengeStage: 'implementation', primary: {}, challenger: {} };
    const legacy = { pairId: 'HOK-1', challengeStage: 'plan', primary: {}, challenger: {} };
    writeState({
      tasks: {
        'HOK-1': {
          challengeExecutionIntent: canonical,
          challengeIntent: legacy,
        },
      },
    });
    const intent = resolveChallengeIntent({ repoDir, issueId: 'HOK-1', challengePairId: 'HOK-1' });
    assert.deepEqual(intent, canonical);
  });

  it('resolveChallengeIntent falls back to the legacy challengeIntent key when canonical is absent', () => {
    const legacy = { pairId: 'HOK-1', challengeStage: 'plan', primary: {}, challenger: {} };
    writeState({ tasks: { 'HOK-1': { challengeIntent: legacy } } });
    const intent = resolveChallengeIntent({ repoDir, issueId: 'HOK-1', challengePairId: 'HOK-1' });
    assert.deepEqual(intent, legacy);
  });

  it('resolveChallengeIntent finds the challenger task via the pairId_c fallback key', () => {
    const canonical = { pairId: 'HOK-1', challengeStage: 'implementation', primary: {}, challenger: {} };
    writeState({ tasks: { 'HOK-1_c': { challengeExecutionIntent: canonical } } });
    const intent = resolveChallengeIntent({ repoDir, issueId: 'HOK-1_c', challengePairId: 'HOK-1' });
    assert.deepEqual(intent, canonical);
  });

  it('resolveChallengeIntent returns undefined when there is no challenge pair', () => {
    assert.equal(resolveChallengeIntent({ repoDir, issueId: 'HOK-1' }), undefined);
  });

  it('resolveChallengeIntent prefers a feature-dir intent artifact over state', () => {
    const featureDirIntent = { pairId: 'HOK-1', challengeStage: 'review', primary: {}, challenger: {} };
    const stateIntent = { pairId: 'HOK-1', challengeStage: 'implementation', primary: {}, challenger: {} };
    writeState({ tasks: { 'HOK-1': { challengeExecutionIntent: stateIntent } } });
    const featureDir = join(repoDir, 'features', 'hok-1-fix-thing');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'challenge-intent.json'), JSON.stringify(featureDirIntent), 'utf-8');

    const intent = resolveChallengeIntent({
      repoDir,
      worktreePath: repoDir,
      branchName: 'task/hok-1-fix-thing',
      issueId: 'HOK-1',
      challengePairId: 'HOK-1',
    });
    assert.deepEqual(intent, featureDirIntent);
  });
});

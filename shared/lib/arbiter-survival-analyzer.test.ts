import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeSurvival,
  type PullRequestMetadata,
  type ReferenceEvidence,
  type SurvivalGitRepository,
} from './arbiter-survival-analyzer.ts';
import { canonicalSerialize } from './arbiter-survival-label.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const LATER = 'd'.repeat(40);
const PR_URL = 'https://github.com/acme/widgets/pull/7';
const PR: PullRequestMetadata = {
  number: 7,
  url: PR_URL,
  mergedAt: '2025-01-01T00:00:00.000Z',
  baseSha: BASE,
  headSha: HEAD,
  title: 'HOK-7 change widget',
};

const changeDiff = [
  '--- a/widget.txt',
  '+++ b/widget.txt',
  '@@ -2 +2 @@',
  '-old',
  '+new',
].join('\n');

function fixture(input: {
  terminal?: string;
  postDiff?: string;
  references?: ReferenceEvidence[];
  pr?: Partial<PullRequestMetadata>;
  throwHistory?: boolean;
  rename?: boolean;
} = {}) {
  const terminal = input.terminal ?? 'first\nnew\n';
  const postDiff = input.postDiff ?? [
    '--- a/other.txt', '+++ b/other.txt', '@@ -1 +1 @@', '-old', '+new',
  ].join('\n');
  const git: SurvivalGitRepository = {
    firstParentHistory() {
      if (input.throwHistory) throw new Error('shallow checkout');
      return [
        { sha: LATER, parent: MERGE, committedAt: '2025-01-10T00:00:00.000Z', subject: 'unrelated', authorName: 'Jane Human' },
        { sha: MERGE, parent: BASE, committedAt: '2025-01-01T00:00:00.000Z', subject: 'Merge pull request #7 from acme/widget', authorName: 'Jane Human' },
        { sha: BASE, parent: null, committedAt: '2024-12-01T00:00:00.000Z', subject: 'base' },
      ];
    },
    diff(base, head) {
      if (base === BASE && head === HEAD) {
        return input.rename ? changeDiff.replaceAll('widget.txt', 'new-widget.txt').replace('--- a/new-widget.txt', '--- a/old-widget.txt') : changeDiff;
      }
      if (base === MERGE && head === LATER) return postDiff;
      return '';
    },
    nameStatus(base, head) {
      if (base === BASE && head === HEAD) return input.rename ? 'R100\told-widget.txt\tnew-widget.txt' : 'M\twidget.txt';
      return '';
    },
    fileAt(sha, path) {
      const renamed = input.rename;
      if (sha === BASE && path === (renamed ? 'old-widget.txt' : 'widget.txt')) return 'first\nold\n';
      if (sha === HEAD && path === (renamed ? 'new-widget.txt' : 'widget.txt')) return 'first\nnew\n';
      if (sha === LATER && path === (renamed ? 'new-widget.txt' : 'widget.txt')) return terminal;
      return null;
    },
  };
  return {
    owner: 'acme', repo: 'widgets', integrationBranch: 'auto/integration', git,
    github: {
      pullRequest: () => ({ ...PR, ...input.pr }),
      referencesForPullRequest: () => input.references ?? [],
    },
    horizons: [14] as const,
    now: new Date('2026-01-01T00:00:00.000Z'),
    computedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('emits deterministic, line-anchored survival labels without wavemill state', () => {
  const options = fixture();
  const first = analyzeSurvival(options);
  const second = analyzeSurvival(options);
  assert.deepEqual(first, second);
  assert.equal(canonicalSerialize(first[0]!), canonicalSerialize(second[0]!));
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome.report_outcome, 'survived');
  assert.equal(first[0].outcome.survival_ratio, 1);
  assert.deepEqual(first[0].line_ranges[0], {
    path: 'widget.txt',
    old: { start: 2, end: 2, sha: BASE },
    new: { start: 2, end: 2, sha: HEAD },
  });
  assert.equal(first[0].envelope.horizon_terminal_sha, LATER);
});

test('follows meaningful renames and ignores formatter-only post-merge churn', () => {
  const labels = analyzeSurvival(fixture({
    rename: true,
    terminal: 'first\n  new  \n',
    postDiff: ['--- a/new-widget.txt', '+++ b/new-widget.txt', '@@ -2 +2 @@', '-new', '+  new  '].join('\n'),
  }));
  assert.equal(labels[0].line_ranges[0].path, 'new-widget.txt');
  assert.equal(labels[0].outcome.report_outcome, 'survived');
});

test('detects exact revert and attributes a single human undoer', () => {
  const labels = analyzeSurvival(fixture({
    terminal: 'first\nold\n',
    postDiff: changeDiff.replace('-old', '-new').replace('+new', '+old'),
  }));
  assert.equal(labels[0].outcome.report_outcome, 'reverted');
  assert.equal(labels[0].outcome.reverted, true);
  assert.equal(labels[0].outcome.undone_by, 'human');
  assert.deepEqual(labels[0].outcome.reason_codes, ['exact_revert']);
});

test('records partial rewrites as intersecting follow-up evidence', () => {
  const labels = analyzeSurvival(fixture({
    terminal: 'first\nrewritten\n',
    postDiff: ['--- a/widget.txt', '+++ b/widget.txt', '@@ -2 +2 @@', '-new', '+rewritten'].join('\n'),
  }));
  assert.equal(labels[0].outcome.survival_ratio, 0);
  assert.equal(labels[0].outcome.followup, true);
  assert.equal(labels[0].outcome.report_outcome, 'substantially_rewritten');
  assert.ok(labels[0].outcome.reason_codes.includes('line_range_followup'));
});

test('uses linked references, redispatches, and explicit pre-merge provenance as follow-up inputs', () => {
  const references: ReferenceEvidence[] = [
    { kind: 'linked', url: 'https://github.com/acme/widgets/issues/8' },
    { kind: 'redispatch', url: 'https://github.com/acme/widgets/issues/9' },
  ];
  const labels = analyzeSurvival(fixture({ references, pr: { preMergeHumanEdit: true } }));
  assert.equal(labels[0].outcome.report_outcome, 'followup');
  assert.equal(labels[0].outcome.undone_by, 'human');
  assert.deepEqual(labels[0].outcome.reason_codes, [
    'linked_issue_or_pr', 'task_redispatch', 'pre_merge_human_edit',
  ]);
});

test('emits explicit missing rows for unelapsed horizons and inaccessible history', () => {
  const unelapsed = analyzeSurvival({ ...fixture(), now: new Date('2025-01-02T00:00:00.000Z') });
  assert.equal(unelapsed[0].outcome.report_outcome, null);
  assert.deepEqual(unelapsed[0].outcome.reason_codes, ['missing_horizon']);
  assert.deepEqual(analyzeSurvival(fixture({ throwHistory: true })), []);
});

test('rejects main and records a supplied replay terminal anchor', () => {
  assert.throws(() => analyzeSurvival({ ...fixture(), integrationBranch: 'main' }), /unsupported/);
  const defaultTerminal = analyzeSurvival(fixture());
  const labels = analyzeSurvival({ ...fixture(), terminalSha: MERGE });
  assert.equal(labels[0].envelope.horizon_terminal_sha, MERGE);
  assert.notEqual(labels[0].envelope.horizon_terminal_sha, defaultTerminal[0].envelope.horizon_terminal_sha);
});

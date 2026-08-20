import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  reapStaleChallengers,
  type ReaperDeps,
} from './reap-stale-challengers.ts';

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'reap-stale-challengers-'));
  const stateFile = join(repo, '.wavemill', 'workflow-state.json');
  const worktree = join(repo, 'worktrees', 'demo-challenger');
  const featureDir = join(worktree, 'features', 'demo-challenger');
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(join(repo, '.wavemill'), { recursive: true });
  writeFileSync(join(featureDir, '.challenge-aborted.json'), '{"reason":"failed"}\n');
  writeFileSync(join(featureDir, '.coding-failure-handoff.json'), '{"stage":"coding"}\n');
  writeFileSync(stateFile, JSON.stringify({
    tasks: {
      'HOK-2839_c': {
        slug: 'demo-challenger',
        branch: 'task/demo-challenger',
        worktree,
        pr: '',
        status: 'active',
        phase: 'coding',
        challengeRole: 'challenger',
        challengeAborted: 'terminal_stage_failure',
      },
    },
  }, null, 2));
  return { repo, stateFile, worktree };
}

function depsFor(fx: ReturnType<typeof fixture>, opts: { dirty?: boolean; openPr?: boolean } = {}) {
  const calls: string[] = [];
  const deps: ReaperDeps = {
    git(args) {
      calls.push(`git ${args.join(' ')}`);
      if (args.join(' ') === 'worktree list --porcelain') {
        return `worktree ${fx.worktree}\nHEAD abc\nbranch refs/heads/task/demo-challenger\n\n`;
      }
      if (args.join(' ') === 'for-each-ref --format=%(refname:short) refs/heads/task') {
        return 'task/demo-challenger\n';
      }
      if (args.join(' ') === `-C ${fx.worktree} status --porcelain`) {
        return opts.dirty ? ' M file.ts\n' : '';
      }
      return '';
    },
    gh(args) {
      calls.push(`gh ${args.join(' ')}`);
      return opts.openPr ? '[{"number":1175}]' : '[]';
    },
    now() {
      return '2026-08-20T00:00:00.000Z';
    },
  };
  return { deps, calls };
}

test('dry-run reports stale challenger without removing resources', async () => {
  const fx = fixture();
  const { deps, calls } = depsFor(fx);

  const decisions = await reapStaleChallengers(fx.repo, fx.stateFile, false, deps);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'would-remove');
  assert.ok(calls.every((call) => !call.includes('worktree remove')));
});

test('force archives artifacts, marks state aborted, and removes clean resources', async () => {
  const fx = fixture();
  const { deps, calls } = depsFor(fx);

  const decisions = await reapStaleChallengers(fx.repo, fx.stateFile, true, deps);

  assert.equal(decisions[0].action, 'removed');
  const state = JSON.parse(readFileSync(fx.stateFile, 'utf-8'));
  assert.equal(state.tasks['HOK-2839_c'].status, 'aborted');
  assert.equal(state.tasks['HOK-2839_c'].phase, 'aborted');
  assert.equal(readFileSync(join(fx.repo, '.wavemill', 'evals', 'artifacts', 'HOK-2839_c', '.challenge-aborted.json'), 'utf-8'), '{"reason":"failed"}\n');
  assert.ok(calls.includes(`git worktree remove --force ${fx.worktree}`));
  assert.ok(calls.includes('git branch -D task/demo-challenger'));
});

test('force skips dirty challenger worktree', async () => {
  const fx = fixture();
  const { deps, calls } = depsFor(fx, { dirty: true });

  const decisions = await reapStaleChallengers(fx.repo, fx.stateFile, true, deps);

  assert.equal(decisions[0].action, 'skipped');
  assert.deepEqual(decisions[0].reasons, ['dirty worktree']);
  assert.ok(calls.every((call) => !call.includes('worktree remove')));
});

test('force skips challenger branch with an open PR', async () => {
  const fx = fixture();
  const { deps, calls } = depsFor(fx, { openPr: true });

  const decisions = await reapStaleChallengers(fx.repo, fx.stateFile, true, deps);

  assert.equal(decisions[0].action, 'skipped');
  assert.deepEqual(decisions[0].reasons, ['open PR']);
  assert.ok(calls.every((call) => !call.includes('branch -D')));
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCiConcurrency, formatCiConcurrency } from './check-ci-concurrency.ts';

async function withRepo(workflow: string, fn: (repoDir: string) => void): Promise<void> {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'ci-concurrency-'));
  try {
    mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), workflow);
    fn(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

const CONCURRENCY_STANZA = `concurrency:
  group: \${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.run_id) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;

const AGGREGATOR_JOBS = `jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
  shell-and-unit:
    name: Shell and Unit Tests
    runs-on: ubuntu-latest
    if: always()
    needs: [unit]
    steps:
      - name: Fail if any test job did not succeed
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')
        run: exit 1
`;

function workflowWith(concurrency: string, jobs = AGGREGATOR_JOBS): string {
  return `name: CI

on:
  pull_request:
  push:
    branches: [main, auto/integration]

${concurrency}
permissions:
  contents: read

${jobs}`;
}

test('the real repository ci.yml satisfies the concurrency contract', () => {
  const result = checkCiConcurrency();

  assert.equal(result.ok, true, formatCiConcurrency(result));
  assert.deepEqual(result.problems, []);
  assert.match(formatCiConcurrency(result), /ci-concurrency: ok/);
});

test('a fixture workflow with the full stanza passes', async () => {
  await withRepo(workflowWith(CONCURRENCY_STANZA), (repoDir) => {
    const result = checkCiConcurrency(repoDir);

    assert.equal(result.ok, true, formatCiConcurrency(result));
  });
});

test('fails when the concurrency block is missing entirely', async () => {
  await withRepo(workflowWith(''), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /missing top-level `concurrency:` block/);
  });
});

test('fails when PR-number grouping is removed from the group expression', async () => {
  await withRepo(workflowWith(`concurrency:
  group: \${{ github.event_name == 'pull_request' && format('{0}-pr', github.workflow) || format('{0}-{1}', github.workflow, github.run_id) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /github\.event\.pull_request\.number/);
  });
});

test('fails when non-PR runs are not isolated by run_id', async () => {
  await withRepo(workflowWith(`concurrency:
  group: \${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.ref) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /github\.run_id/);
    assert.match(message, /protected-branch, scheduled, or manual runs/);
  });
});

test('fails when the group expression is not event-conditional', async () => {
  await withRepo(workflowWith(`concurrency:
  group: \${{ format('{0}-pr-{1}-{2}', github.workflow, github.event.pull_request.number, github.run_id) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /group is not conditioned on `github\.event_name == 'pull_request'`/);
  });
});

test('fails when cancel-in-progress is a bare `true` literal (all events cancel)', async () => {
  await withRepo(workflowWith(`concurrency:
  group: \${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.run_id) }}
  cancel-in-progress: true
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /bare literal/);
    assert.match(message, /cancel-in-progress: true/);
  });
});

test('fails when cancel-in-progress is absent', async () => {
  await withRepo(workflowWith(`concurrency:
  group: \${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.run_id) }}
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /no `cancel-in-progress:` key/);
  });
});

test('fails when cancel-in-progress expression is not scoped to pull_request', async () => {
  await withRepo(workflowWith(`concurrency:
  group: \${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.run_id) }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /`cancel-in-progress` is not conditioned on `github\.event_name == 'pull_request'`/);
  });
});

test('a job-level concurrency block does not satisfy the top-level requirement', async () => {
  await withRepo(workflowWith('', `jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    concurrency:
      group: \${{ github.event_name == 'pull_request' && format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) || format('{0}-{1}', github.workflow, github.run_id) }}
      cancel-in-progress: \${{ github.event_name == 'pull_request' }}
  shell-and-unit:
    name: Shell and Unit Tests
    runs-on: ubuntu-latest
    steps:
      - name: Fail if any test job did not succeed
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')
        run: exit 1
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /missing top-level `concurrency:` block/);
  });
});

test('fails when the aggregator no longer fails on cancelled dependencies', async () => {
  await withRepo(workflowWith(CONCURRENCY_STANZA, `jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
  shell-and-unit:
    name: Shell and Unit Tests
    runs-on: ubuntu-latest
    if: always()
    needs: [unit]
    steps:
      - name: Fail if any test job did not succeed
        if: contains(needs.*.result, 'failure')
        run: exit 1
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /no longer fails on `contains\(needs\.\*\.result, 'cancelled'\)`/);
  });
});

test('fails when the aggregator job is missing', async () => {
  await withRepo(workflowWith(CONCURRENCY_STANZA, `jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.match(message, /aggregator job named "Shell and Unit Tests" not found/);
  });
});

test('reports every violated guard at once', async () => {
  await withRepo(workflowWith(`concurrency:
  group: ci-global
  cancel-in-progress: true
`, `jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
`), (repoDir) => {
    const result = checkCiConcurrency(repoDir);
    const message = formatCiConcurrency(result);

    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 5);
    assert.match(message, /github\.event\.pull_request\.number/);
    assert.match(message, /github\.run_id/);
    assert.match(message, /group is not conditioned/);
    assert.match(message, /bare literal/);
    assert.match(message, /aggregator job named "Shell and Unit Tests" not found/);
  });
});

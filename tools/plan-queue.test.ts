import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '..');
const planQueueTool = resolve(__dirname, 'plan-queue.ts');
const fixture = resolve(repoDir, 'fixtures/plan-queue/backlog-basic.json');

function runPlanQueue(args: string[], input?: string, cwd = repoDir) {
  return spawnSync('npx', ['tsx', planQueueTool, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env },
    input,
  });
}

function parseJson(stdout: string) {
  return JSON.parse(stdout) as {
    availableNow: string[];
    queuedAfterDependencies: Array<{ taskId: string; ancestors: string[] }>;
    avoidRunningTogether: string[][];
    needsTriage: Array<{ reason: string; edge: { type: string; from: string; to: string; source: string } }>;
  };
}

describe('plan-queue CLI', () => {
  it('emits queuePlan JSON from a backlog file', () => {
    const stdout = execFileSync('npx', ['tsx', planQueueTool, '--backlog-file', fixture, '--json'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env },
    });

    const result = parseJson(stdout);
    assert.deepEqual(Object.keys(result), [
      'availableNow',
      'queuedAfterDependencies',
      'avoidRunningTogether',
      'needsTriage',
    ]);
    assert.deepEqual(result.availableNow, ['HOK-10', 'HOK-13']);
    assert.deepEqual(result.queuedAfterDependencies, [
      { taskId: 'HOK-11', ancestors: ['HOK-10'] },
      { taskId: 'HOK-12', ancestors: ['HOK-10'] },
    ]);
    assert.deepEqual(result.avoidRunningTogether, [['HOK-11', 'HOK-13']]);
    assert.equal(result.needsTriage.length, 1);
    assert.equal(result.needsTriage[0].reason, 'unknown_endpoint');
    assert.deepEqual(result.needsTriage[0].edge, {
      type: 'depends_on',
      from: 'HOK-99',
      to: 'HOK-14',
      source: 'explicit',
    });
  });

  it('renders preview sections to stdout', () => {
    const result = runPlanQueue(['--backlog-file', fixture, '--preview']);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Available Now/);
    assert.match(result.stdout, /Queued After Dependencies/);
    assert.match(result.stdout, /Avoid Running Together/);
    assert.match(result.stdout, /Needs Triage/);
  });

  it('reads stdin and matches file-mode JSON', () => {
    const fixtureContent = readFileSync(fixture, 'utf8');
    const fileMode = parseJson(runPlanQueue(['--backlog-file', fixture, '--json']).stdout);
    const stdinMode = parseJson(runPlanQueue(['--stdin', '--json'], fixtureContent).stdout);

    assert.deepEqual(stdinMode, fileMode);
  });

  it('fails clearly for a missing backlog file', () => {
    const result = runPlanQueue(['--backlog-file', '/nonexistent/plan-queue.json', '--json']);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Failed to read backlog file/);
  });

  it('fails clearly for malformed JSON', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-test-'));
    try {
      const malformed = join(tempDir, 'malformed.json');
      writeFileSync(malformed, '[{"id": "HOK-1"');

      const result = runPlanQueue(['--backlog-file', malformed, '--json']);

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /parse backlog JSON/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits empty arrays and preview placeholders for an empty backlog', () => {
    const emptyJson = '[]';
    const jsonResult = parseJson(runPlanQueue(['--stdin', '--json'], emptyJson).stdout);
    assert.deepEqual(jsonResult, {
      availableNow: [],
      queuedAfterDependencies: [],
      avoidRunningTogether: [],
      needsTriage: [],
    });

    const previewResult = runPlanQueue(['--stdin', '--preview'], emptyJson);
    assert.equal(previewResult.status, 0);
    assert.equal((previewResult.stdout.match(/\(none\)/g) ?? []).length, 4);
  });

  it('fails with a usage hint when no input source is provided', () => {
    const result = runPlanQueue(['--json']);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /provide exactly one input source/);
  });

  it('writes JSON to stdout and preview to stderr when both are requested', () => {
    const result = runPlanQueue(['--backlog-file', fixture, '--json', '--preview']);

    assert.equal(result.status, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stderr, /Available Now/);
    assert.match(result.stderr, /Queued After Dependencies/);
    assert.match(result.stderr, /Avoid Running Together/);
    assert.match(result.stderr, /Needs Triage/);
  });

  it('creates a cache file for file mode and reports cache stats in preview mode', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-cache-test-'));
    try {
      const first = runPlanQueue(['--backlog-file', fixture, '--cache-key', 'smoke-test', '--preview'], undefined, tempDir);
      const cachePath = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans', 'smoke-test.json');

      assert.equal(first.status, 0);
      assert.equal(existsSync(cachePath), true);
      assert.match(first.stderr, /cache: hits=0 misses=0 pruned=0/);

      const second = runPlanQueue(['--backlog-file', fixture, '--cache-key', 'smoke-test', '--preview'], undefined, tempDir);
      assert.equal(second.status, 0);
      assert.match(second.stderr, /cache: hits=0 misses=0 pruned=0/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips cache writes when --no-cache is provided', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-cache-disabled-test-'));
    try {
      const result = runPlanQueue(
        ['--backlog-file', fixture, '--cache-key', 'disabled-test', '--no-cache', '--preview'],
        undefined,
        tempDir,
      );

      assert.equal(result.status, 0);
      assert.equal(existsSync(join(tempDir, '.wavemill', 'cache', 'task-dependency-plans', 'disabled-test.json')), false);
      assert.doesNotMatch(result.stderr, /cache: hits=/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('merges retained cached edges into planning when backlog fingerprints are unchanged', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'plan-queue-cache-edges-test-'));
    try {
      const backlogPath = join(tempDir, 'backlog.json');
      const backlog = [
        { id: 'HOK-1', title: 'First', state: 'Todo', labels: [], blocks: [] },
        { id: 'HOK-2', title: 'Second', state: 'Todo', labels: [], blocks: [] },
      ];
      writeFileSync(backlogPath, `${JSON.stringify(backlog, null, 2)}\n`, 'utf8');

      const cacheDir = join(tempDir, '.wavemill', 'cache', 'task-dependency-plans');
      const cachePath = join(cacheDir, 'cached-edges.json');
      mkdirSync(cacheDir, { recursive: true });
      const { computeTaskFingerprint } = await import('../shared/lib/task-dependency-plan-cache.ts');
      const fingerprints = Object.fromEntries(backlog.map((task) => [task.id, computeTaskFingerprint(task)]));
      writeFileSync(
        cachePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            projectSlug: 'cached-edges',
            updatedAt: '2026-01-01T00:00:00.000Z',
            fingerprints,
            edges: [
              {
                from: 'HOK-1',
                to: 'HOK-2',
                fromFingerprint: fingerprints['HOK-1'],
                toFingerprint: fingerprints['HOK-2'],
                kind: 'inferred',
                type: 'depends_on',
                classifiedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      const result = runPlanQueue(['--backlog-file', backlogPath, '--cache-key', 'cached-edges', '--json'], undefined, tempDir);

      assert.equal(result.status, 0);
      assert.deepEqual(parseJson(result.stdout), {
        availableNow: ['HOK-1'],
        queuedAfterDependencies: [{ taskId: 'HOK-2', ancestors: ['HOK-1'] }],
        avoidRunningTogether: [],
        needsTriage: [],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

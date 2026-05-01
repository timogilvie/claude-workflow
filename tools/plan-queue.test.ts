import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '..');
const planQueueTool = resolve(__dirname, 'plan-queue.ts');
const fixture = resolve(repoDir, 'fixtures/plan-queue/backlog-basic.json');

function runPlanQueue(args: string[], input?: string) {
  return spawnSync('npx', ['tsx', planQueueTool, ...args], {
    cwd: repoDir,
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
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPreview, normalizeBacklog } from './plan-queue.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tool = resolve(__dirname, 'plan-queue.ts');
const repoRoot = resolve(__dirname, '..');

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'plan-queue-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('plan-queue CLI', () => {
  it('emits JSON output from --backlog', () => withTmpDir((dir) => {
    const backlog = join(dir, 'backlog.json');
    writeFileSync(backlog, JSON.stringify({
      tasks: [{ id: 'HOK-100' }, { id: 'HOK-101' }, { id: 'HOK-102' }],
      edges: [{ type: 'depends_on', from: 'HOK-100', to: 'HOK-102' }],
    }));

    const stdout = execFileSync('npx', ['tsx', tool, '--backlog', backlog], { encoding: 'utf-8', cwd: repoRoot });
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.waves.map((w: { taskIds: string[] }) => w.taskIds), [['HOK-100', 'HOK-101'], ['HOK-102']]);
    assert.deepEqual(parsed.queues.find((q: { taskId: string }) => q.taskId === 'HOK-102')?.ancestors, ['HOK-100']);
    assert.deepEqual(parsed.triage, []);
  }));

  it('renders preview with all sections', () => withTmpDir((dir) => {
    const backlog = join(dir, 'backlog.json');
    writeFileSync(backlog, JSON.stringify({
      tasks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      edges: [{ type: 'depends_on', from: 'A', to: 'C' }, { type: 'shared_surface', from: 'A', to: 'B' }],
    }));

    const stdout = execFileSync('npx', ['tsx', tool, '--backlog', backlog, '--preview'], { encoding: 'utf-8', cwd: repoRoot });
    const headers = ['Available Now', 'Queued After Dependencies', 'Avoid Running Together', 'Needs Triage'];
    let last = -1;
    for (const h of headers) {
      const next = stdout.indexOf(h);
      assert.ok(next > last);
      last = next;
    }
  }));

  it('accepts stdin JSON input', () => withTmpDir((dir) => {
    const raw = JSON.stringify([{ id: 'A' }, { id: 'B' }]);
    const fromStdin = spawnSync('npx', ['tsx', tool], { input: raw, encoding: 'utf-8', cwd: repoRoot });
    assert.equal(fromStdin.status, 0);
    const parsed = JSON.parse(fromStdin.stdout);
    assert.deepEqual(parsed, {
      waves: [{ index: 0, taskIds: ['A', 'B'] }],
      queues: [{ taskId: 'A', ancestors: [] }, { taskId: 'B', ancestors: [] }],
      triage: [],
    });
  }));

  it('handles empty backlog array', () => withTmpDir(() => {
    const run = spawnSync('npx', ['tsx', tool], { input: '[]', encoding: 'utf-8', cwd: repoRoot });
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout), { waves: [], queues: [], triage: [] });
  }));

  it('fails with malformed JSON', () => withTmpDir((dir) => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{invalid');
    const run = spawnSync('npx', ['tsx', tool, '--backlog', bad], { encoding: 'utf-8', cwd: repoRoot });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Error:/);
  }));

  it('returns exit 2 for planner cycle errors', () => withTmpDir((dir) => {
    const backlog = join(dir, 'cycle.json');
    writeFileSync(backlog, JSON.stringify({
      tasks: [{ id: 'A' }, { id: 'B' }],
      edges: [{ type: 'depends_on', from: 'A', to: 'B' }, { type: 'depends_on', from: 'B', to: 'A' }],
    }));

    const run = spawnSync('npx', ['tsx', tool, '--backlog', backlog], { encoding: 'utf-8', cwd: repoRoot });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Error:/);
  }));

  it('fails when stdin is empty', () => {
    const run = spawnSync('npx', ['tsx', tool], { input: '', encoding: 'utf-8', cwd: repoRoot });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /stdin is empty/i);
  });

  it('fails when --backlog and --project are both provided', () => withTmpDir((dir) => {
    const backlog = join(dir, 'backlog.json');
    writeFileSync(backlog, '[]');
    const run = spawnSync('npx', ['tsx', tool, '--backlog', backlog, '--project', 'X'], { encoding: 'utf-8', cwd: repoRoot });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /only one of --backlog or --project/i);
  }));
});

describe('plan-queue helpers', () => {
  it('formatPreview renders expected sections and values', () => {
    const text = formatPreview(
      {
        waves: [{ index: 0, taskIds: ['A'] }, { index: 1, taskIds: ['B'] }],
        queues: [{ taskId: 'B', ancestors: ['A'] }],
        triage: [{ edge: { type: 'depends_on', from: 'X', to: 'A' }, reason: 'unknown_endpoint' }],
      },
      [{ type: 'shared_surface', from: 'A', to: 'B' }],
    );

    assert.match(text, /Available Now/);
    assert.match(text, /Queued After Dependencies/);
    assert.match(text, /B \(after: A\)/);
    assert.match(text, /Avoid Running Together/);
    assert.match(text, /A \+ B/);
    assert.match(text, /Needs Triage/);
    assert.match(text, /X/);
  });

  it('normalizeBacklog supports array and object formats and rejects invalid', () => {
    const arrayResult = normalizeBacklog([
      { identifier: 'A', relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'B' } }] } },
      { id: 'B' },
    ]);
    assert.equal(arrayResult.tasks.length, 2);
    assert.deepEqual(arrayResult.edges, [{ type: 'depends_on', from: 'A', to: 'B', source: 'inferred', reason: 'linear.blocks' }]);

    const objectResult = normalizeBacklog({
      tasks: [{ id: 'A' }],
      edges: [{ type: 'shared_surface', from: 'A', to: 'B' }],
    });
    assert.equal(objectResult.tasks.length, 1);
    assert.equal(objectResult.edges.length, 1);

    assert.throws(() => normalizeBacklog(123), /backlog must be/);
  });
});

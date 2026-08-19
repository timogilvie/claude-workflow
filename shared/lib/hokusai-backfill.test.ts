import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { backfillHokusaiSubmissions, selectBackfillRecords } from './hokusai-backfill.ts';

function rec(id: string, issueId: string, ts: string) {
  return { id, issueId, timestamp: ts } as never;
}

function makeRepo(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hokusai-backfill-'));
  mkdirSync(join(dir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(
    join(dir, '.wavemill', 'evals', 'evals.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  return dir;
}

describe('hokusai backfill selection', () => {
  const records = [
    rec('a', 'HOK-1', '2026-08-16T10:00:00Z'),
    rec('b', 'HOK-2', '2026-08-17T10:00:00Z'),
    rec('c', 'HOK-3', '2026-08-18T10:00:00Z'),
    rec('d', 'HOK-4', '2026-08-19T10:00:00Z'),
  ];

  it('selects an inclusive date range', () => {
    const got = selectBackfillRecords(records, { since: '2026-08-17', until: '2026-08-18' });
    assert.deepEqual(got.map((r) => (r as { id: string }).id), ['b', 'c']);
  });

  it('explicit ids override the date range', () => {
    const got = selectBackfillRecords(records, { since: '2026-08-17', until: '2026-08-18', ids: ['a', 'd'] });
    assert.deepEqual(got.map((r) => (r as { id: string }).id), ['a', 'd']);
  });

  it('skips records with no timestamp rather than guessing', () => {
    const got = selectBackfillRecords([...records, { id: 'e', issueId: 'HOK-5' } as never], {
      since: '2026-08-01', until: '2026-08-31',
    });
    assert.ok(!got.some((r) => (r as { id: string }).id === 'e'));
  });
});

describe('hokusai backfill safety', () => {
  it('refuses to resubmit the entire corpus with no selector', async () => {
    const dir = makeRepo([rec('a', 'HOK-1', '2026-08-17T10:00:00Z')]);
    try {
      await assert.rejects(
        () => backfillHokusaiSubmissions({ repoDir: dir }),
        /requires --since\/--until or --ids/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry run reports per-record outcomes without enqueuing', async () => {
    const dir = makeRepo([rec('a', 'HOK-1', '2026-08-17T10:00:00Z')]);
    try {
      const summary = await backfillHokusaiSubmissions({
        repoDir: dir, since: '2026-08-17', until: '2026-08-17',
      });
      assert.equal(summary.applied, false);
      assert.equal(summary.selected, 1);
      // The preview runs the real gates, so it reports a skip reason rather
      // than optimistically claiming every selected record would land.
      assert.ok(summary.results[0].status.startsWith('would-'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates malformed lines in the eval log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hokusai-backfill-'));
    mkdirSync(join(dir, '.wavemill', 'evals'), { recursive: true });
    writeFileSync(
      join(dir, '.wavemill', 'evals', 'evals.jsonl'),
      `${JSON.stringify(rec('a', 'HOK-1', '2026-08-17T10:00:00Z'))}\n{not json\n`,
    );
    try {
      const summary = await backfillHokusaiSubmissions({
        repoDir: dir, since: '2026-08-17', until: '2026-08-17',
      });
      assert.equal(summary.selected, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

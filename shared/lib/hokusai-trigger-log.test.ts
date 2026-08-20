import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { appendTriggerLogEntry, summarizeTriggerLog } from './hokusai-trigger-log.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('hokusai-trigger-log', () => {
  it('returns null when no trigger log exists', () => {
    assert.equal(summarizeTriggerLog(makeTempDir('hokusai-trigger-log-')), null);
  });

  it('summarizes recent outcomes and skips malformed lines', () => {
    const repoDir = makeTempDir('hokusai-trigger-log-');
    appendTriggerLogEntry({ at: '2026-08-18T12:00:00.000Z', evalId: 'e1', issueId: 'HOK-1', status: 'enqueued' }, repoDir);
    appendTriggerLogEntry({ at: '2026-08-18T12:01:00.000Z', evalId: 'e2', issueId: 'HOK-2', status: 'disabled', source: 'consent' }, repoDir);
    appendTriggerLogEntry({ at: '2026-08-18T12:02:00.000Z', evalId: 'e3', issueId: 'HOK-3', status: 'failed', detail: 'boom' }, repoDir);
    appendTriggerLogEntry({ at: '2026-07-01T12:00:00.000Z', evalId: 'old', issueId: 'HOK-0', status: 'disabled', source: 'repo_config' }, repoDir);
    writeFileSync(join(repoDir, '.wavemill', 'hokusai', 'trigger-log.jsonl'), '{ nope\n', { flag: 'a' });

    const summary = summarizeTriggerLog(repoDir, {
      sinceDays: 14,
      now: new Date('2026-08-19T12:00:00.000Z'),
    });

    assert.ok(summary);
    assert.equal(summary.counts.enqueued, 1);
    assert.equal(summary.counts.disabled, 1);
    assert.equal(summary.counts.failed, 1);
    assert.equal(summary.blocked, 2);
    assert.equal(summary.firstBlockedAt, '2026-08-18T12:01:00.000Z');
    assert.equal(summary.lastBlockedAt, '2026-08-18T12:02:00.000Z');
    assert.equal(summary.lastEnqueuedAt, '2026-08-18T12:00:00.000Z');
    assert.deepEqual(summary.disabledSources, ['consent']);
  });

  it('warns instead of throwing when append fails', () => {
    const warn = mock.method(console, 'warn', () => undefined);
    appendTriggerLogEntry({ at: '2026-08-18T12:00:00.000Z', status: 'enqueued' }, '/dev/null/not-a-dir');
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /failed to append trigger log/);
    mock.restoreAll();
  });
});

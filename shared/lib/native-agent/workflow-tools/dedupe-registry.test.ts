import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createInMemoryDedupeRegistry,
  expandIssueKey,
  linearCommentKey,
  githubCreatePrKey,
  type DedupeRecord,
} from './dedupe.ts';

describe('dedupe-registry: createInMemoryDedupeRegistry', () => {
  it('starts empty', () => {
    const reg = createInMemoryDedupeRegistry();
    assert.equal(reg.size(), 0);
  });

  it('get returns undefined for unknown key', () => {
    const reg = createInMemoryDedupeRegistry();
    assert.equal(reg.get('nonexistent'), undefined);
  });

  it('record and get round-trips a DedupeRecord', () => {
    const reg = createInMemoryDedupeRegistry();
    const key = 'linear_comment:HOK-1:coding:sess-1:abc123';
    const rec: DedupeRecord = {
      key,
      outcome: 'created',
      ref: { system: 'linear', kind: 'comment', id: 'cmt-1', url: 'https://linear.app/c/1' },
    };
    reg.record(key, rec);
    const got = reg.get(key);
    assert.ok(got);
    assert.equal(got.key, key);
    assert.equal(got.outcome, 'created');
    assert.deepEqual(got.ref, rec.ref);
  });

  it('size increments with each new record', () => {
    const reg = createInMemoryDedupeRegistry();
    reg.record('k1', { key: 'k1', outcome: 'created', ref: null });
    reg.record('k2', { key: 'k2', outcome: 'reused', ref: null });
    assert.equal(reg.size(), 2);
  });

  it('recording the same key twice overwrites, size stays the same', () => {
    const reg = createInMemoryDedupeRegistry();
    const key = 'write_stage_result:HOK-1:coding:completed';
    reg.record(key, { key, outcome: 'created', ref: null });
    reg.record(key, { key, outcome: 'updated', ref: null });
    assert.equal(reg.size(), 1);
    assert.equal(reg.get(key)?.outcome, 'updated');
  });

  it('clock injection sets recordedAt deterministically', () => {
    const reg = createInMemoryDedupeRegistry({ clock: () => 42_000 });
    reg.record('k', { key: 'k', outcome: 'created', ref: null });
    assert.equal(reg.get('k')?.recordedAt, 42_000);
  });

  it('separate keys never collide (linear vs expand)', () => {
    const reg = createInMemoryDedupeRegistry();
    const commentKey = linearCommentKey({ issue: 'HOK-1', phase: 'coding', sessionId: 's', body: 'hello' });
    const expKey = expandIssueKey({ issue: 'HOK-1', phase: 'coding', sessionId: 's', contentHash: '' });
    reg.record(commentKey, { key: commentKey, outcome: 'created', ref: null });
    reg.record(expKey, { key: expKey, outcome: 'created', ref: null });
    assert.notEqual(commentKey, expKey);
    assert.equal(reg.size(), 2);
  });

  it('denial does not auto-write a registry entry', () => {
    // The registry itself has no concept of "denial" — only the tool layer writes.
    // Verify that simply getting a missing key doesn't create an entry.
    const reg = createInMemoryDedupeRegistry();
    reg.get('some-key');
    assert.equal(reg.size(), 0);
  });

  it('allows looking up after a policy-denied sequence (registry is untouched)', () => {
    const reg = createInMemoryDedupeRegistry();
    const key = 'linear_comment:HOK-5:ready:sess-1:deadbeef01234567';
    // Simulate: policy denial means NO record() call happened.
    // Registry size remains 0.
    assert.equal(reg.get(key), undefined);
    assert.equal(reg.size(), 0);
    // Now the same key can be created (simulate allowed phase retry).
    reg.record(key, { key, outcome: 'created', ref: null });
    assert.equal(reg.get(key)?.outcome, 'created');
  });
});

describe('dedupe-registry: expandIssueKey', () => {
  it('identical inputs produce identical keys', () => {
    const input = { issue: 'HOK-1', phase: 'planning' as const, sessionId: 'sess-1', contentHash: '' };
    assert.equal(expandIssueKey(input), expandIssueKey(input));
  });

  it('key format is stable: expand_issue:<issue>:<phase>:<sessionId>:<contentHash>', () => {
    const key = expandIssueKey({ issue: 'HOK-1', phase: 'planning', sessionId: 'sess-abc', contentHash: '' });
    assert.equal(key, 'expand_issue:HOK-1:planning:sess-abc:');
  });

  it('changing issue changes the key', () => {
    const a = expandIssueKey({ issue: 'HOK-1', phase: 'planning', sessionId: 's', contentHash: '' });
    const b = expandIssueKey({ issue: 'HOK-2', phase: 'planning', sessionId: 's', contentHash: '' });
    assert.notEqual(a, b);
  });

  it('changing phase changes the key', () => {
    const a = expandIssueKey({ issue: 'HOK-1', phase: 'planning', sessionId: 's', contentHash: '' });
    const b = expandIssueKey({ issue: 'HOK-1', phase: 'coding', sessionId: 's', contentHash: '' });
    assert.notEqual(a, b);
  });

  it('changing sessionId changes the key', () => {
    const a = expandIssueKey({ issue: 'HOK-1', phase: 'planning', sessionId: 'sess-1', contentHash: '' });
    const b = expandIssueKey({ issue: 'HOK-1', phase: 'planning', sessionId: 'sess-2', contentHash: '' });
    assert.notEqual(a, b);
  });

  it('does not collide with linearCommentKey for same parameters', () => {
    const expKey = expandIssueKey({ issue: 'HOK-1', phase: 'planning', sessionId: 's', contentHash: '' });
    const cmtKey = linearCommentKey({ issue: 'HOK-1', phase: 'planning', sessionId: 's', body: '' });
    assert.notEqual(expKey, cmtKey);
  });

  it('does not collide with githubCreatePrKey', () => {
    const expKey = expandIssueKey({ issue: 'HOK-1', phase: 'planning', sessionId: 's', contentHash: '' });
    const prKey = githubCreatePrKey({ repo: 'owner/repo', head: 'feat', base: 'main', headSha: 'abc' });
    assert.notEqual(expKey, prKey);
  });
});

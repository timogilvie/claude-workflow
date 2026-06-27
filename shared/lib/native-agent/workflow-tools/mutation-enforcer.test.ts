import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enforceMutation } from './mutation-enforcer.ts';
import type { MutationRecord } from './mutation-record.ts';

describe('workflow-tools: mutation enforcer', () => {
  it('executes allowed mutations and records executed outcomes', async () => {
    const records: MutationRecord[] = [];
    let executorCalls = 0;

    const result = await enforceMutation({
      tool: 'github_create_pr',
      phase: 'review',
      action: 'create_pr',
      target: { repo: 'owner/repo', head: 'feature', base: 'main' },
      execute: async () => {
        executorCalls += 1;
        return { ok: true, idempotency: { key: 'github_create_pr:test' } };
      },
      record: async record => {
        records.push(record);
      },
    });

    assert.equal(executorCalls, 1);
    assert.deepEqual(result, {
      tool: 'github_create_pr',
      phase: 'review',
      action: 'create_pr',
      target: { repo: 'owner/repo', head: 'feature', base: 'main' },
      allowed: true,
      outcome: 'executed',
      result: { ok: true, idempotency: { key: 'github_create_pr:test' } },
    });
    assert.deepEqual(records, [
      {
        tool: 'github_create_pr',
        phase: 'review',
        action: 'create_pr',
        target: { repo: 'owner/repo', head: 'feature', base: 'main' },
        outcome: 'executed',
        result: { ok: true, idempotency: { key: 'github_create_pr:test' } },
      },
    ]);
  });

  it('records denials and does not execute denied mutations', async () => {
    const records: MutationRecord[] = [];
    let executorCalls = 0;
    let sideEffect = false;

    const result = await enforceMutation({
      tool: 'linear_comment',
      phase: 'ready',
      action: 'comment',
      target: { issue: 'HOK-2359' },
      execute: async () => {
        executorCalls += 1;
        sideEffect = true;
        return { ok: true };
      },
      record: async record => {
        records.push(record);
      },
    });

    assert.equal(executorCalls, 0);
    assert.equal(sideEffect, false);
    assert.deepEqual(result, {
      tool: 'linear_comment',
      phase: 'ready',
      action: 'comment',
      target: { issue: 'HOK-2359' },
      allowed: false,
      outcome: 'denied',
      code: 'ready_mutation_denied',
      reason: 'ready_mutation_denied: unrelated comment not allowed in ready phase',
    });
    assert.deepEqual(records, [
      {
        tool: 'linear_comment',
        phase: 'ready',
        action: 'comment',
        target: { issue: 'HOK-2359' },
        outcome: 'denied',
        code: 'ready_mutation_denied',
        reason: 'ready_mutation_denied: unrelated comment not allowed in ready phase',
      },
    ]);
  });

  it('records failed execution outcomes', async () => {
    const records: MutationRecord[] = [];

    const result = await enforceMutation({
      tool: 'github_add_label',
      phase: 'review',
      action: 'add_label',
      target: { repo: 'owner/repo', label: 'needs-review' },
      execute: async () => {
        throw new Error('provider exploded');
      },
      record: async record => {
        records.push(record);
      },
    });

    assert.deepEqual(result, {
      tool: 'github_add_label',
      phase: 'review',
      action: 'add_label',
      target: { repo: 'owner/repo', label: 'needs-review' },
      allowed: true,
      outcome: 'failed',
      code: 'external_error',
      reason: 'github_add_label failed: provider exploded',
      error: {
        name: 'Error',
        message: 'provider exploded',
      },
    });
    assert.deepEqual(records, [
      {
        tool: 'github_add_label',
        phase: 'review',
        action: 'add_label',
        target: { repo: 'owner/repo', label: 'needs-review' },
        outcome: 'failed',
        code: 'external_error',
        reason: 'github_add_label failed: provider exploded',
        error: {
          name: 'Error',
          message: 'provider exploded',
        },
      },
    ]);
  });

  it('fails closed for unknown tool and action combinations', async () => {
    const records: MutationRecord[] = [];
    let executorCalls = 0;

    const result = await enforceMutation({
      tool: 'linear_comment',
      phase: 'review',
      action: 'add_label',
      target: { issue: 'HOK-2359' },
      execute: async () => {
        executorCalls += 1;
        return { ok: true };
      },
      record: async record => {
        records.push(record);
      },
    });

    assert.equal(executorCalls, 0);
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'unknown_combination');
    assert.match(result.reason, /unknown_combination/);
    assert.deepEqual(records, [
      {
        tool: 'linear_comment',
        phase: 'review',
        action: 'add_label',
        target: { issue: 'HOK-2359' },
        outcome: 'denied',
        code: 'unknown_combination',
        reason: 'unknown_combination: no policy entry for phase=review tool=linear_comment action=add_label',
      },
    ]);
  });
});

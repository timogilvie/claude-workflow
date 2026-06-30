import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enforceMutation } from './mutation-enforcer.ts';
import type { MutationRecord } from './mutation-record.ts';
import { ApprovalStore, createApprovalGate } from './approval-gate.ts';

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

// ---------------------------------------------------------------------------
// Approval gate integration
// ---------------------------------------------------------------------------

describe('workflow-tools: mutation enforcer approval gate', () => {
  it('returns approval_needed and does not execute when gate pauses', async () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, () => ({ riskReason: 'high-risk comment', argSummary: 'body=test' }));
    const records: MutationRecord[] = [];
    let executed = false;

    const result = await enforceMutation({
      tool: 'linear_comment',
      phase: 'coding',
      action: 'comment',
      target: { issue: 'HOK-1234' },
      approvalGate: gate,
      sessionId: 'session-test',
      argSummary: 'body=test',
      execute: async () => {
        executed = true;
        return { ok: true };
      },
      record: async (r) => { records.push(r); },
    });

    assert.equal(executed, false);
    assert.equal(result.outcome, 'approval_needed');
    if (result.outcome === 'approval_needed') {
      assert.equal(typeof result.requestId, 'string');
      assert.equal(result.riskReason, 'high-risk comment');
    }
    assert.equal(records.length, 1);
    assert.equal(records[0]!.outcome, 'approval_needed');
  });

  it('executes after grant and does not produce approval_needed', async () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, () => ({ riskReason: 'risky', argSummary: '' }));
    const SESSION = 'session-grant-test';

    // First call — should return approval_needed
    const firstResult = await enforceMutation({
      tool: 'linear_comment',
      phase: 'coding',
      action: 'comment',
      target: { issue: 'HOK-1' },
      approvalGate: gate,
      sessionId: SESSION,
      argSummary: '',
      execute: async () => ({ ok: true }),
      record: async () => {},
    });
    assert.equal(firstResult.outcome, 'approval_needed');

    // Grant the request
    const requestId = (firstResult as { requestId: string }).requestId;
    store.grant(SESSION, requestId);

    // Second call — should execute
    let executed = false;
    const secondResult = await enforceMutation({
      tool: 'linear_comment',
      phase: 'coding',
      action: 'comment',
      target: { issue: 'HOK-1' },
      approvalGate: gate,
      sessionId: SESSION,
      argSummary: '',
      execute: async () => { executed = true; return { ok: true }; },
      record: async () => {},
    });

    assert.equal(executed, true);
    assert.equal(secondResult.outcome, 'executed');
  });

  it('returns denied outcome when gate returns denied decision', async () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, () => ({ riskReason: 'risky', argSummary: '' }));
    const SESSION = 'session-deny-test';

    // First call to create pending
    const firstResult = await enforceMutation({
      tool: 'linear_comment',
      phase: 'coding',
      action: 'comment',
      target: {},
      approvalGate: gate,
      sessionId: SESSION,
      argSummary: '',
      execute: async () => ({ ok: true }),
      record: async () => {},
    });
    const requestId = (firstResult as { requestId: string }).requestId;
    store.deny(SESSION, requestId);

    // Second call — should be denied
    let executed = false;
    const secondResult = await enforceMutation({
      tool: 'linear_comment',
      phase: 'coding',
      action: 'comment',
      target: {},
      approvalGate: gate,
      sessionId: SESSION,
      argSummary: '',
      execute: async () => { executed = true; return { ok: true }; },
      record: async () => {},
    });

    assert.equal(executed, false);
    assert.equal(secondResult.outcome, 'denied');
    if (secondResult.outcome === 'denied') {
      assert.equal(secondResult.code, 'approval_denied');
    }
  });

  it('runs without gate when approvalGate is omitted (backward compat)', async () => {
    let executed = false;
    const result = await enforceMutation({
      tool: 'linear_comment',
      phase: 'coding',
      action: 'comment',
      execute: async () => { executed = true; return { ok: true }; },
      record: async () => {},
    });
    assert.equal(executed, true);
    assert.equal(result.outcome, 'executed');
  });
});

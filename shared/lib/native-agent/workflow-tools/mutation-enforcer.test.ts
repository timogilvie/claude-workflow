import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enforceMutation, type EnforcedResult } from './mutation-enforcer.ts';
import type { MutationRecord } from './mutation-record.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A recorder that collects all records written to it. */
function makeRecorder(): { fn: (r: MutationRecord) => void; records: MutationRecord[] } {
  const records: MutationRecord[] = [];
  return {
    fn: (r) => { records.push(r); },
    records,
  };
}

/** A recorder that always throws. */
function throwingRecorder(): (r: MutationRecord) => Promise<void> {
  return async () => { throw new Error('recorder failure'); };
}

const FIXED_CLOCK = () => 12345;

// ---------------------------------------------------------------------------
// Review-phase denial of out-of-scope mutations
// ---------------------------------------------------------------------------

describe('mutation-enforcer: review-phase denial', () => {
  it('denies merge in review phase and does not call executor', async () => {
    const recorder = makeRecorder();
    let executorCalled = false;
    const executor = async () => { executorCalled = true; return 'should not reach'; };

    const result = await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'merge' },
      executor,
      recorder: recorder.fn,
      clock: FIXED_CLOCK,
    });

    assert.equal(result.status, 'denied');
    assert.equal(executorCalled, false, 'executor must not be called on denial');
    assert.equal(recorder.records.length, 1);
    assert.equal(recorder.records[0].outcome, 'denied');
    if (recorder.records[0].outcome === 'denied') {
      assert.match(recorder.records[0].reason, /merge/);
      assert.equal(recorder.records[0].timestampMs, 12345);
    }
  });

  it('denied review-phase record contains correct tool/phase/action', async () => {
    const recorder = makeRecorder();
    const result = await enforceMutation({
      context: { phase: 'review', tool: 'github_add_label', action: 'merge' },
      executor: async () => 'nope',
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'denied');
    if (result.status === 'denied') {
      assert.equal(result.record.tool, 'github_add_label');
      assert.equal(result.record.phase, 'review');
      assert.equal(result.record.action, 'merge');
    }
  });

  it('denies unknown (tool, action) combination in review phase', async () => {
    const recorder = makeRecorder();
    let executorCalled = false;

    const result = await enforceMutation({
      // @ts-expect-error testing unknown action
      context: { phase: 'review', tool: 'linear_comment', action: 'teleport' },
      executor: async () => { executorCalled = true; },
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'denied');
    assert.equal(executorCalled, false);
    assert.equal(recorder.records.length, 1);
    if (recorder.records[0].outcome === 'denied') {
      assert.match(recorder.records[0].reason, /unknown_combination/);
    }
  });
});

// ---------------------------------------------------------------------------
// Ready-phase denial of non-remediation mutations
// ---------------------------------------------------------------------------

describe('mutation-enforcer: ready-phase denial', () => {
  it('denies general PR creation in ready phase without calling executor', async () => {
    const recorder = makeRecorder();
    let executorCalled = false;

    const result = await enforceMutation({
      context: { phase: 'ready', tool: 'github_create_pr', action: 'create_pr' },
      executor: async () => { executorCalled = true; return 'x'; },
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'denied');
    assert.equal(executorCalled, false);
    assert.equal(recorder.records.length, 1);
    if (recorder.records[0].outcome === 'denied') {
      assert.match(recorder.records[0].reason, /ready_mutation_denied/);
    }
  });

  it('denies comment in ready phase without calling executor', async () => {
    const recorder = makeRecorder();
    let executorCalled = false;

    const result = await enforceMutation({
      context: { phase: 'ready', tool: 'linear_comment', action: 'comment' },
      executor: async () => { executorCalled = true; return 'x'; },
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'denied');
    assert.equal(executorCalled, false);
    assert.equal(recorder.records.length, 1);
  });

  it('denies add_label in ready phase without calling executor', async () => {
    const recorder = makeRecorder();
    let executorCalled = false;

    const result = await enforceMutation({
      context: { phase: 'ready', tool: 'github_add_label', action: 'add_label' },
      executor: async () => { executorCalled = true; return 'x'; },
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'denied');
    assert.equal(executorCalled, false);
  });

  it('denies merge in ready phase without calling executor', async () => {
    const recorder = makeRecorder();
    let executorCalled = false;

    const result = await enforceMutation({
      context: { phase: 'ready', tool: 'github_create_pr', action: 'merge' },
      executor: async () => { executorCalled = true; return 'x'; },
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'denied');
    assert.equal(executorCalled, false);
  });
});

// ---------------------------------------------------------------------------
// Allowed review/PR mutation execution
// ---------------------------------------------------------------------------

describe('mutation-enforcer: allowed review-phase mutations', () => {
  it('allows github_create_pr create_pr in review phase and calls executor once', async () => {
    const recorder = makeRecorder();
    let callCount = 0;
    const executor = async () => { callCount++; return { ok: true, tool: 'github_create_pr' as const }; };

    const result = await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
      executor,
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'executed');
    assert.equal(callCount, 1, 'executor must be called exactly once');
    assert.equal(recorder.records.length, 1);
    assert.equal(recorder.records[0].outcome, 'executed');
  });

  it('allows github_create_pr update_pr in review phase', async () => {
    const recorder = makeRecorder();

    const result = await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'update_pr' },
      executor: async () => ({ ok: true }),
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'executed');
  });

  it('allows github_add_label add_label in review phase', async () => {
    const recorder = makeRecorder();

    const result = await enforceMutation({
      context: { phase: 'review', tool: 'github_add_label', action: 'add_label' },
      executor: async () => ({ ok: true }),
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'executed');
  });

  it('returns the executor result when allowed', async () => {
    const recorder = makeRecorder();
    const payload = { ok: true, tool: 'github_create_pr' as const, idempotency: { key: 'k', outcome: 'created' as const, ref: null } };

    const result: EnforcedResult<typeof payload> = await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
      executor: async () => payload,
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'executed');
    if (result.status === 'executed') {
      assert.deepEqual(result.result, payload);
    }
  });

  it('attaches idempotency data to executed record via extractIdempotency', async () => {
    const recorder = makeRecorder();
    const ref = { system: 'github' as const, kind: 'pull_request' as const, id: '99', url: 'https://example.com/99' };
    const payload = { ok: true, idempotency: { key: 'github_create_pr:k', outcome: 'created' as const, ref } };

    await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
      executor: async () => payload,
      recorder: recorder.fn,
      extractIdempotency: (r) => ({
        idempotencyKey: r.idempotency.key,
        idempotencyOutcome: r.idempotency.outcome,
        ref: r.idempotency.ref,
      }),
    });

    const record = recorder.records[0];
    assert.equal(record.outcome, 'executed');
    if (record.outcome === 'executed') {
      assert.equal(record.idempotencyKey, 'github_create_pr:k');
      assert.equal(record.idempotencyOutcome, 'created');
      assert.deepEqual(record.ref, ref);
    }
  });
});

// ---------------------------------------------------------------------------
// Allowed ready stale_base / merge_conflict execution
// ---------------------------------------------------------------------------

describe('mutation-enforcer: allowed ready-phase remediation mutations', () => {
  it('allows stale_base remediation in ready phase', async () => {
    const recorder = makeRecorder();
    let executorCalled = false;

    const result = await enforceMutation({
      context: { phase: 'ready', tool: 'github_create_pr', action: 'stale_base' },
      executor: async () => { executorCalled = true; return { ok: true }; },
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'executed');
    assert.equal(executorCalled, true);
    assert.equal(recorder.records.length, 1);
    assert.equal(recorder.records[0].outcome, 'executed');
  });

  it('allows merge_conflict remediation in ready phase', async () => {
    const recorder = makeRecorder();

    const result = await enforceMutation({
      context: { phase: 'ready', tool: 'github_create_pr', action: 'merge_conflict' },
      executor: async () => ({ ok: true }),
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'executed');
    assert.equal(recorder.records.length, 1);
  });

  it('allows write_stage_result in ready phase', async () => {
    const recorder = makeRecorder();

    const result = await enforceMutation({
      context: { phase: 'ready', tool: 'write_stage_result', action: 'write_stage_result' },
      executor: async () => ({ ok: true }),
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'executed');
  });
});

// ---------------------------------------------------------------------------
// Failed path: executor throws
// ---------------------------------------------------------------------------

describe('mutation-enforcer: executor failure path', () => {
  it('produces a failed record when executor throws', async () => {
    const recorder = makeRecorder();

    const result = await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
      executor: async () => { throw new Error('network error'); },
      recorder: recorder.fn,
      clock: FIXED_CLOCK,
    });

    assert.equal(result.status, 'failed');
    assert.equal(recorder.records.length, 1);
    const record = recorder.records[0];
    assert.equal(record.outcome, 'failed');
    if (record.outcome === 'failed') {
      assert.equal(record.error, 'network error');
      assert.equal(record.tool, 'github_create_pr');
      assert.equal(record.phase, 'review');
      assert.equal(record.action, 'create_pr');
      assert.equal(record.timestampMs, 12345);
    }
  });

  it('preserves the original error in the failed result', async () => {
    const recorder = makeRecorder();
    const originalError = new Error('original');

    const result = await enforceMutation({
      context: { phase: 'review', tool: 'linear_comment', action: 'comment' },
      executor: async () => { throw originalError; },
      recorder: recorder.fn,
    });

    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error, originalError);
    }
  });
});

// ---------------------------------------------------------------------------
// Exactly one record per path
// ---------------------------------------------------------------------------

describe('mutation-enforcer: exactly one record per path', () => {
  it('writes exactly one record on denied path', async () => {
    const recorder = makeRecorder();
    await enforceMutation({
      context: { phase: 'ready', tool: 'linear_comment', action: 'comment' },
      executor: async () => 'x',
      recorder: recorder.fn,
    });
    assert.equal(recorder.records.length, 1);
  });

  it('writes exactly one record on executed path', async () => {
    const recorder = makeRecorder();
    await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
      executor: async () => ({ ok: true }),
      recorder: recorder.fn,
    });
    assert.equal(recorder.records.length, 1);
  });

  it('writes exactly one record on failed path', async () => {
    const recorder = makeRecorder();
    await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
      executor: async () => { throw new Error('fail'); },
      recorder: recorder.fn,
    });
    assert.equal(recorder.records.length, 1);
  });

  it('multiple invocations write one record each', async () => {
    const recorder = makeRecorder();
    // First: denial
    await enforceMutation({
      context: { phase: 'ready', tool: 'linear_comment', action: 'comment' },
      executor: async () => 'x',
      recorder: recorder.fn,
    });
    // Second: executed
    await enforceMutation({
      context: { phase: 'review', tool: 'linear_comment', action: 'comment' },
      executor: async () => ({ ok: true }),
      recorder: recorder.fn,
    });
    assert.equal(recorder.records.length, 2);
    assert.equal(recorder.records[0].outcome, 'denied');
    assert.equal(recorder.records[1].outcome, 'executed');
  });
});

// ---------------------------------------------------------------------------
// Recorder failure propagation
// ---------------------------------------------------------------------------

describe('mutation-enforcer: recorder failures surface to caller', () => {
  it('propagates recorder error on denied path', async () => {
    await assert.rejects(
      () => enforceMutation({
        context: { phase: 'ready', tool: 'linear_comment', action: 'comment' },
        executor: async () => 'x',
        recorder: throwingRecorder(),
      }),
      /recorder failure/,
    );
  });

  it('propagates recorder error on executed path', async () => {
    await assert.rejects(
      () => enforceMutation({
        context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
        executor: async () => ({ ok: true }),
        recorder: throwingRecorder(),
      }),
      /recorder failure/,
    );
  });

  it('propagates recorder error on failed path', async () => {
    await assert.rejects(
      () => enforceMutation({
        context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
        executor: async () => { throw new Error('exec error'); },
        recorder: throwingRecorder(),
      }),
      /recorder failure/,
    );
  });
});

// ---------------------------------------------------------------------------
// Clock injection
// ---------------------------------------------------------------------------

describe('mutation-enforcer: clock injection', () => {
  it('uses injected clock for denied record timestamp', async () => {
    const recorder = makeRecorder();
    await enforceMutation({
      context: { phase: 'ready', tool: 'linear_comment', action: 'comment' },
      executor: async () => 'x',
      recorder: recorder.fn,
      clock: () => 9999,
    });
    assert.equal(recorder.records[0].timestampMs, 9999);
  });

  it('uses injected clock for executed record timestamp', async () => {
    const recorder = makeRecorder();
    await enforceMutation({
      context: { phase: 'review', tool: 'github_add_label', action: 'add_label' },
      executor: async () => ({ ok: true }),
      recorder: recorder.fn,
      clock: () => 8888,
    });
    assert.equal(recorder.records[0].timestampMs, 8888);
  });

  it('uses injected clock for failed record timestamp', async () => {
    const recorder = makeRecorder();
    await enforceMutation({
      context: { phase: 'review', tool: 'github_create_pr', action: 'create_pr' },
      executor: async () => { throw new Error('fail'); },
      recorder: recorder.fn,
      clock: () => 7777,
    });
    assert.equal(recorder.records[0].timestampMs, 7777);
  });
});

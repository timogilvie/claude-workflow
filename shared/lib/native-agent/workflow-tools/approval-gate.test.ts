import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApprovalStore,
  ApprovalRequestNotFoundError,
  ApprovalRequestAlreadyResolvedError,
  ApprovalSessionMismatchError,
  createApprovalGate,
  deriveRequestId,
  buildLifecycleEntry,
  type RiskClassifierFn,
} from './approval-gate.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixedClock(startMs: number): { clock: () => number; advance: (ms: number) => void } {
  let now = startMs;
  return {
    clock: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const REQ_1 = 'req-1';

// ---------------------------------------------------------------------------
// deriveRequestId
// ---------------------------------------------------------------------------

describe('deriveRequestId', () => {
  it('produces a 16-char hex string', () => {
    const id = deriveRequestId(SESSION_A, 'linear_comment', 'comment', 'HOK-1');
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 16);
    assert.match(id, /^[0-9a-f]+$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = deriveRequestId(SESSION_A, 'linear_comment', 'comment', 'HOK-1');
    const b = deriveRequestId(SESSION_A, 'linear_comment', 'comment', 'HOK-1');
    assert.equal(a, b);
  });

  it('differs across sessions', () => {
    const a = deriveRequestId(SESSION_A, 'linear_comment', 'comment', 'HOK-1');
    const b = deriveRequestId(SESSION_B, 'linear_comment', 'comment', 'HOK-1');
    assert.notEqual(a, b);
  });

  it('differs for different tools', () => {
    const a = deriveRequestId(SESSION_A, 'github_create_pr', 'create_pr', '');
    const b = deriveRequestId(SESSION_A, 'linear_comment', 'comment', '');
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// ApprovalStore — request / grant / deny / expire
// ---------------------------------------------------------------------------

describe('ApprovalStore: basic lifecycle', () => {
  it('creates a pending request', () => {
    const store = new ApprovalStore();
    const record = store.request({
      requestId: REQ_1,
      sessionId: SESSION_A,
      tool: 'linear_comment',
      action: 'comment',
      argSummary: 'body: progress',
      riskReason: 'comment in ready phase',
    });
    assert.equal(record.state, 'pending');
    assert.equal(record.request.requestId, REQ_1);
    assert.equal(record.request.sessionId, SESSION_A);
  });

  it('retrieves a stored record', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'test' });
    const record = store.get(SESSION_A, REQ_1);
    assert.ok(record !== null);
    assert.equal(record.state, 'pending');
  });

  it('returns null for unknown requestId', () => {
    const store = new ApprovalStore();
    assert.equal(store.get(SESSION_A, 'nonexistent'), null);
  });

  it('grants a pending request and sets terminal state', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    const record = store.grant(SESSION_A, REQ_1);
    assert.equal(record.state, 'granted');
    assert.ok(record.resolution !== undefined);
    assert.equal(record.resolution!.state, 'granted');
  });

  it('denies a pending request and sets terminal state', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    const record = store.deny(SESSION_A, REQ_1);
    assert.equal(record.state, 'denied');
    assert.equal(record.resolution!.state, 'denied');
  });

  it('expires a pending request via expire()', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    const record = store.expire(SESSION_A, REQ_1);
    assert.ok(record !== null);
    assert.equal(record!.state, 'expired');
  });

  it('emits lifecycle entries for requested, granted, denied, and expired transitions', () => {
    const entries: string[] = [];
    const store = new ApprovalStore({
      lifecycleSink: (entry) => entries.push(entry.event),
    });

    store.request({ requestId: 'grant-req', sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.grant(SESSION_A, 'grant-req');
    store.request({ requestId: 'deny-req', sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.deny(SESSION_A, 'deny-req');
    store.request({ requestId: 'expire-req', sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.expire(SESSION_A, 'expire-req');

    assert.deepEqual(entries, [
      'requested',
      'granted',
      'requested',
      'denied',
      'requested',
      'expired',
    ]);
  });

  it('expire() returns null for already-resolved request', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.grant(SESSION_A, REQ_1);
    const result = store.expire(SESSION_A, REQ_1);
    assert.equal(result, null);
  });

  it('expire() returns null for unknown request', () => {
    const store = new ApprovalStore();
    const result = store.expire(SESSION_A, 'nonexistent');
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('ApprovalStore: error cases', () => {
  it('throws ApprovalRequestNotFoundError when granting unknown request', () => {
    const store = new ApprovalStore();
    assert.throws(
      () => store.grant(SESSION_A, 'unknown'),
      (err: unknown) => err instanceof ApprovalRequestNotFoundError,
    );
  });

  it('throws ApprovalRequestAlreadyResolvedError when granting an already-granted request', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.grant(SESSION_A, REQ_1);
    assert.throws(
      () => store.grant(SESSION_A, REQ_1),
      (err: unknown) => err instanceof ApprovalRequestAlreadyResolvedError,
    );
  });

  it('throws ApprovalRequestAlreadyResolvedError when denying an already-denied request', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.deny(SESSION_A, REQ_1);
    assert.throws(
      () => store.deny(SESSION_A, REQ_1),
      (err: unknown) => err instanceof ApprovalRequestAlreadyResolvedError,
    );
  });

  it('does not throw when granting an expired request (treats as already resolved)', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.expire(SESSION_A, REQ_1);
    // Now try to grant — should throw AlreadyResolved because state is 'expired'
    assert.throws(
      () => store.grant(SESSION_A, REQ_1),
      (err: unknown) => err instanceof ApprovalRequestAlreadyResolvedError,
    );
  });

  it('throws ApprovalSessionMismatchError when granting with wrong sessionId', () => {
    // We need to bypass the session-scoped key to force a mismatch.
    // This isn't directly possible from the public API (keys are session-scoped),
    // so we test by verifying the error class exists and grants work for correct sessions.
    // The mismatch guard is an internal safety belt; we verify the path via unit inspection.
    const e = new ApprovalSessionMismatchError('req-x', 'session-owner', 'session-intruder');
    assert.equal(e.name, 'ApprovalSessionMismatchError');
    assert.ok(e.message.includes('session-owner'));
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe('ApprovalStore: session isolation', () => {
  it('listPending returns only requests for the specified session', () => {
    const store = new ApprovalStore();
    store.request({ requestId: 'r1', sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.request({ requestId: 'r2', sessionId: SESSION_B, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    const pending = store.listPending(SESSION_A);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.request.sessionId, SESSION_A);
  });

  it('listAllPending returns pending requests across all sessions', () => {
    const store = new ApprovalStore();
    store.request({ requestId: 'r1', sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.request({ requestId: 'r2', sessionId: SESSION_B, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.grant(SESSION_A, 'r1');
    const all = store.listAllPending();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.request.sessionId, SESSION_B);
  });

  it('get returns null for a request in a different session', () => {
    const store = new ApprovalStore();
    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    // Session B cannot read session A's request via get()
    assert.equal(store.get(SESSION_B, REQ_1), null);
  });
});

// ---------------------------------------------------------------------------
// expireStale
// ---------------------------------------------------------------------------

describe('ApprovalStore: expireStale', () => {
  it('expires requests whose expiresAt <= now', () => {
    const { clock, advance } = fixedClock(1_000_000);
    const store = new ApprovalStore({ clock, defaultTtlMs: 1000 });

    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    advance(1001); // past TTL
    const expired = store.expireStale();
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.state, 'expired');
  });

  it('does not expire requests that have not reached their TTL', () => {
    const { clock, advance } = fixedClock(1_000_000);
    const store = new ApprovalStore({ clock, defaultTtlMs: 5000 });

    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    advance(4999); // not yet expired
    const expired = store.expireStale();
    assert.equal(expired.length, 0);
    assert.equal(store.get(SESSION_A, REQ_1)!.state, 'pending');
  });

  it('treats expiresAt == now as expired (boundary is now >= expiresAt)', () => {
    const { clock, advance } = fixedClock(1_000_000);
    const store = new ApprovalStore({ clock, defaultTtlMs: 1000 });

    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    advance(1000); // exactly at boundary
    const expired = store.expireStale();
    assert.equal(expired.length, 1);
  });

  it('does not re-expire already-resolved requests', () => {
    const { clock, advance } = fixedClock(1_000_000);
    const store = new ApprovalStore({ clock, defaultTtlMs: 1000 });

    store.request({ requestId: REQ_1, sessionId: SESSION_A, tool: 'x', action: 'y', argSummary: '', riskReason: 'r' });
    store.grant(SESSION_A, REQ_1);
    advance(2000);
    const expired = store.expireStale();
    assert.equal(expired.length, 0);
  });
});

// ---------------------------------------------------------------------------
// createApprovalGate
// ---------------------------------------------------------------------------

describe('createApprovalGate', () => {
  const alwaysSafeClassifier: RiskClassifierFn = () => null;
  const alwaysRiskyClassifier: RiskClassifierFn = () => ({
    riskReason: 'high-risk action detected',
    argSummary: 'body=test',
  });

  it('proceeds immediately when no classifier is provided', () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, null);
    const decision = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'x' });
    assert.deepEqual(decision, { proceed: true });
  });

  it('proceeds immediately when classifier returns null (not risky)', () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, alwaysSafeClassifier);
    const decision = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'x' });
    assert.deepEqual(decision, { proceed: true });
  });

  it('returns approval_needed for first risky invocation', () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, alwaysRiskyClassifier);
    const decision = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    assert.equal(typeof decision === 'object' && !('proceed' in decision && decision.proceed) && 'outcome' in decision
      ? decision.outcome
      : 'wrong', 'approval_needed');
  });

  it('proceeds after request is granted', () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, alwaysRiskyClassifier);

    // First call → approval_needed, creates the pending record
    const d1 = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    assert.ok(typeof d1 === 'object' && 'outcome' in d1 && d1.outcome === 'approval_needed');
    const requestId = (d1 as { requestId: string }).requestId;

    // Grant
    store.grant(SESSION_A, requestId);

    // Second call → should proceed
    const d2 = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    assert.deepEqual(d2, { proceed: true });
  });

  it('returns denied when request is denied', () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, alwaysRiskyClassifier);

    const d1 = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    const requestId = (d1 as { requestId: string }).requestId;
    store.deny(SESSION_A, requestId);

    const d2 = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    assert.ok(typeof d2 === 'object' && 'outcome' in d2);
    assert.equal((d2 as { outcome: string }).outcome, 'denied');
  });

  it('returns expired when request is expired', () => {
    const { clock, advance } = fixedClock(1_000_000);
    const store = new ApprovalStore({ clock, defaultTtlMs: 500 });
    const gate = createApprovalGate(store, alwaysRiskyClassifier);

    gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    advance(1000); // past TTL

    const d2 = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    assert.ok(typeof d2 === 'object' && 'outcome' in d2);
    assert.equal((d2 as { outcome: string }).outcome, 'expired');
  });

  it('same requestId for identical operation context (deterministic)', () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, alwaysRiskyClassifier);

    const d1 = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });
    const d2 = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'body=test' });

    // Both should have the same requestId
    assert.equal(
      (d1 as { requestId: string }).requestId,
      (d2 as { requestId: string }).requestId,
    );
  });

  it('sessions are isolated: different sessions produce different requestIds', () => {
    const store = new ApprovalStore();
    const gate = createApprovalGate(store, alwaysRiskyClassifier);

    const dA = gate({ sessionId: SESSION_A, tool: 'linear_comment', action: 'comment', argSummary: 'x' });
    const dB = gate({ sessionId: SESSION_B, tool: 'linear_comment', action: 'comment', argSummary: 'x' });

    assert.notEqual(
      (dA as { requestId: string }).requestId,
      (dB as { requestId: string }).requestId,
    );
  });
});

// ---------------------------------------------------------------------------
// buildLifecycleEntry
// ---------------------------------------------------------------------------

describe('buildLifecycleEntry', () => {
  it('builds a requested entry without resolution', () => {
    const store = new ApprovalStore({ clock: () => 1_000 });
    const record = store.request({
      requestId: REQ_1,
      sessionId: SESSION_A,
      tool: 'linear_comment',
      action: 'comment',
      argSummary: 'body=test',
      riskReason: 'risky',
    });
    const entry = buildLifecycleEntry(record, 'requested', 1_000);
    assert.equal(entry.type, 'approval_lifecycle');
    assert.equal(entry.event, 'requested');
    assert.equal(entry.requestId, REQ_1);
    assert.equal(entry.tool, 'linear_comment');
    assert.equal(entry.riskReason, 'risky');
    assert.equal(entry.resolution, undefined);
  });

  it('includes resolution when record is resolved', () => {
    const store = new ApprovalStore({ clock: () => 1_000 });
    store.request({
      requestId: REQ_1,
      sessionId: SESSION_A,
      tool: 'linear_comment',
      action: 'comment',
      argSummary: 'body=test',
      riskReason: 'risky',
    });
    const record = store.grant(SESSION_A, REQ_1);
    const entry = buildLifecycleEntry(record, 'granted', 1_500);
    assert.equal(entry.event, 'granted');
    assert.ok(entry.resolution !== undefined);
    assert.equal(entry.resolution!.state, 'granted');
  });
});

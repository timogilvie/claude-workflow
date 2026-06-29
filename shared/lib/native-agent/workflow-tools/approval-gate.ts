/**
 * Approval Gate — Human approval model for risky runtime operations (HOK-2364).
 *
 * Defines the domain types, session-scoped in-memory store, and injectable gate
 * factory for pausing risky native runtime operations pending human decision.
 *
 * Design rules:
 * - Pure domain model: no filesystem, network, or process I/O.
 * - Clock-injected for deterministic expiry in tests.
 * - Session-scoped: one session cannot resolve another session's requests.
 * - Terminal states (granted, denied, expired) cannot be re-resolved.
 * - requestId is deterministic from (sessionId, tool, action, argSummary) so
 *   a re-invocation after grant executes exactly once.
 * - Risk classification is caller-provided: this module does not define policy.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ApprovalState = 'pending' | 'granted' | 'denied' | 'expired';
export type ApprovalLifecycleEvent = 'requested' | 'granted' | 'denied' | 'expired';

/**
 * Metadata for a pending approval request. All fields must be transcript-safe:
 * no raw secrets, full command payloads, or bearer tokens.
 */
export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  /** Tool or command kind that requires approval. */
  tool: string;
  /** Mutation action or command class. */
  action: string;
  /** Sanitized, human-readable argument summary (no secrets). */
  argSummary: string;
  /** Human-readable risk classification reason from the caller's policy. */
  riskReason: string;
  /** Unix timestamp (ms) when the request was created. */
  requestedAt: number;
  /** Unix timestamp (ms) when the request expires if unresolved. */
  expiresAt: number;
}

export interface ApprovalResolution {
  requestId: string;
  sessionId: string;
  state: 'granted' | 'denied' | 'expired';
  /** Unix timestamp (ms) when the resolution was recorded. */
  resolvedAt: number;
}

export interface ApprovalRecord {
  request: ApprovalRequest;
  state: ApprovalState;
  resolution?: ApprovalResolution;
}

/** Entry written to transcript or stage artifact for each lifecycle event. */
export interface ApprovalLifecycleEntry {
  type: 'approval_lifecycle';
  event: ApprovalLifecycleEvent;
  requestId: string;
  sessionId: string;
  tool: string;
  action: string;
  argSummary: string;
  riskReason: string;
  requestedAt: number;
  expiresAt: number;
  resolution?: { state: 'granted' | 'denied' | 'expired'; resolvedAt: number };
  at: number;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class ApprovalRequestNotFoundError extends Error {
  readonly requestId: string;
  readonly sessionId: string;

  constructor(requestId: string, sessionId: string) {
    super(`Approval request '${requestId}' not found in session '${sessionId}'`);
    this.name = 'ApprovalRequestNotFoundError';
    this.requestId = requestId;
    this.sessionId = sessionId;
  }
}

export class ApprovalRequestAlreadyResolvedError extends Error {
  readonly requestId: string;
  readonly state: ApprovalState;

  constructor(requestId: string, state: ApprovalState) {
    super(`Approval request '${requestId}' is already resolved (state: ${state})`);
    this.name = 'ApprovalRequestAlreadyResolvedError';
    this.requestId = requestId;
    this.state = state;
  }
}

export class ApprovalSessionMismatchError extends Error {
  readonly requestId: string;

  constructor(requestId: string, expectedSession: string, callerSession: string) {
    super(
      `Session mismatch resolving request '${requestId}': ` +
        `request belongs to '${expectedSession}', caller is '${callerSession}'`,
    );
    this.name = 'ApprovalSessionMismatchError';
    this.requestId = requestId;
  }
}

// ---------------------------------------------------------------------------
// ApprovalStore
// ---------------------------------------------------------------------------

export interface ApprovalStoreOptions {
  /** Override wall clock for deterministic expiry in tests. Defaults to Date.now. */
  clock?: () => number;
  /** Default TTL for new requests (ms). Defaults to 5 minutes. */
  defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Session-scoped in-memory approval store.
 *
 * Keyed by `${sessionId}:${requestId}`. Sessions are isolated: only the
 * originating session can resolve its requests. Multiple stores may coexist in
 * tests; production code should use one store per native agent session.
 */
export class ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly clockFn: () => number;
  private readonly defaultTtlMs: number;

  constructor(options: ApprovalStoreOptions = {}) {
    this.clockFn = options.clock ?? (() => Date.now());
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  /** Create a new pending approval request. Overwrites any prior record for the same key. */
  request(params: {
    requestId: string;
    sessionId: string;
    tool: string;
    action: string;
    argSummary: string;
    riskReason: string;
    ttlMs?: number;
  }): ApprovalRecord {
    const now = this.clockFn();
    const ttl = params.ttlMs ?? this.defaultTtlMs;
    const req: ApprovalRequest = {
      requestId: params.requestId,
      sessionId: params.sessionId,
      tool: params.tool,
      action: params.action,
      argSummary: params.argSummary,
      riskReason: params.riskReason,
      requestedAt: now,
      expiresAt: now + ttl,
    };
    const record: ApprovalRecord = { request: req, state: 'pending' };
    this.records.set(storeKey(params.sessionId, params.requestId), record);
    return record;
  }

  /**
   * Grant a pending request. Throws if not found, wrong session, or already resolved.
   * Idempotent for the granted state: after grant, re-resolving with grant throws
   * AlreadyResolvedError.
   */
  grant(sessionId: string, requestId: string): ApprovalRecord {
    return this.resolveTerminal(sessionId, requestId, 'granted');
  }

  /** Deny a pending request. Throws if not found, wrong session, or already resolved. */
  deny(sessionId: string, requestId: string): ApprovalRecord {
    return this.resolveTerminal(sessionId, requestId, 'denied');
  }

  /**
   * Expire a specific pending request. Returns the expired record, or null if
   * not found or already in a terminal state.
   */
  expire(sessionId: string, requestId: string): ApprovalRecord | null {
    const record = this.records.get(storeKey(sessionId, requestId));
    if (!record || record.state !== 'pending') return null;
    return this.applyExpiry(record);
  }

  /**
   * Expire all requests whose expiresAt <= now (across all sessions).
   * Returns the newly expired records.
   */
  expireStale(): ApprovalRecord[] {
    const now = this.clockFn();
    const expired: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state === 'pending' && now >= record.request.expiresAt) {
        expired.push(this.applyExpiry(record));
      }
    }
    return expired;
  }

  /** Look up a record. Returns null if not found. */
  get(sessionId: string, requestId: string): ApprovalRecord | null {
    return this.records.get(storeKey(sessionId, requestId)) ?? null;
  }

  /** All pending requests for a session (does not expire stale entries). */
  listPending(sessionId: string): ApprovalRecord[] {
    const result: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.request.sessionId === sessionId && record.state === 'pending') {
        result.push(record);
      }
    }
    return result;
  }

  /** All pending requests across all sessions. */
  listAllPending(): ApprovalRecord[] {
    const result: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state === 'pending') result.push(record);
    }
    return result;
  }

  private resolveTerminal(
    sessionId: string,
    requestId: string,
    state: 'granted' | 'denied',
  ): ApprovalRecord {
    const key = storeKey(sessionId, requestId);
    const record = this.records.get(key);
    if (!record) {
      throw new ApprovalRequestNotFoundError(requestId, sessionId);
    }
    if (record.request.sessionId !== sessionId) {
      throw new ApprovalSessionMismatchError(requestId, record.request.sessionId, sessionId);
    }
    if (record.state !== 'pending') {
      throw new ApprovalRequestAlreadyResolvedError(requestId, record.state);
    }
    record.state = state;
    record.resolution = { requestId, sessionId, state, resolvedAt: this.clockFn() };
    return record;
  }

  private applyExpiry(record: ApprovalRecord): ApprovalRecord {
    record.state = 'expired';
    record.resolution = {
      requestId: record.request.requestId,
      sessionId: record.request.sessionId,
      state: 'expired',
      resolvedAt: this.clockFn(),
    };
    return record;
  }
}

// ---------------------------------------------------------------------------
// Gate decision types and factory
// ---------------------------------------------------------------------------

/**
 * Decision returned by an ApprovalGateFn.
 *
 * - proceed: true → execute immediately (no approval needed)
 * - approval_needed → create a pending request; do not execute
 * - denied/expired → terminal block; do not execute
 */
export type ApprovalGateDecision =
  | { proceed: true }
  | {
      proceed: false;
      outcome: 'approval_needed';
      requestId: string;
      riskReason: string;
      argSummary: string;
      expiresAt: number;
    }
  | {
      proceed: false;
      outcome: 'denied';
      requestId: string;
      reason: string;
    }
  | {
      proceed: false;
      outcome: 'expired';
      requestId: string;
      reason: string;
    };

/**
 * Injectable approval gate function.
 *
 * Receives the operation context and returns whether execution may proceed.
 * Callers supply this to enforce their risk policy without coupling it to the
 * mutation enforcer or command substrate.
 */
export type ApprovalGateFn = (context: {
  sessionId: string;
  tool: string;
  action: string;
  argSummary: string;
}) => ApprovalGateDecision | Promise<ApprovalGateDecision>;

/**
 * Risk classification result from the caller's policy.
 * Return null to indicate no approval is needed.
 */
export interface RiskClassification {
  riskReason: string;
  /** Sanitized argument summary (no secrets). Defaults to '' if not provided. */
  argSummary?: string;
  /** TTL override for this specific request. */
  ttlMs?: number;
}

export type RiskClassifierFn = (context: {
  tool: string;
  action: string;
  target?: Record<string, unknown>;
}) => RiskClassification | null;

/**
 * Create an ApprovalGateFn bound to an ApprovalStore and an optional risk classifier.
 *
 * The gate lifecycle for each call:
 * 1. If no classifier or classifier returns null → proceed immediately.
 * 2. Compute deterministic requestId from (sessionId, tool, action, argSummary).
 * 3. Expire stale entries.
 * 4. Look up existing record:
 *    - Granted: proceed.
 *    - Denied: return denied decision.
 *    - Expired: return expired decision.
 *    - None or pending: create/refresh pending, return approval_needed.
 */
export function createApprovalGate(
  store: ApprovalStore,
  classifier: RiskClassifierFn | null,
): ApprovalGateFn {
  return (context) => {
    if (!classifier) return { proceed: true };
    const risk = classifier({
      tool: context.tool,
      action: context.action,
    });
    if (!risk) return { proceed: true };

    const argSummary = context.argSummary || risk.argSummary || '';
    const requestId = deriveRequestId(context.sessionId, context.tool, context.action, argSummary);

    // Expire any stale pending requests before checking
    store.expireStale();

    const existing = store.get(context.sessionId, requestId);

    if (existing) {
      if (existing.state === 'granted') {
        return { proceed: true };
      }
      if (existing.state === 'denied') {
        return {
          proceed: false,
          outcome: 'denied',
          requestId,
          reason: `Human denied approval for ${context.tool}/${context.action}: ${risk.riskReason}`,
        };
      }
      if (existing.state === 'expired') {
        return {
          proceed: false,
          outcome: 'expired',
          requestId,
          reason: `Approval request for ${context.tool}/${context.action} expired: ${risk.riskReason}`,
        };
      }
      // Still pending
      return {
        proceed: false,
        outcome: 'approval_needed',
        requestId,
        riskReason: risk.riskReason,
        argSummary,
        expiresAt: existing.request.expiresAt,
      };
    }

    // No existing record — create a new pending request
    const record = store.request({
      requestId,
      sessionId: context.sessionId,
      tool: context.tool,
      action: context.action,
      argSummary,
      riskReason: risk.riskReason,
      ttlMs: risk.ttlMs,
    });

    return {
      proceed: false,
      outcome: 'approval_needed',
      requestId,
      riskReason: risk.riskReason,
      argSummary,
      expiresAt: record.request.expiresAt,
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function storeKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

/**
 * Derive a stable requestId from the operation context.
 *
 * Deterministic so the same operation in the same session always produces
 * the same id — enabling idempotent re-invocation after grant.
 */
export function deriveRequestId(
  sessionId: string,
  tool: string,
  action: string,
  argSummary: string,
): string {
  const input = `${sessionId}\x00${tool}\x00${action}\x00${argSummary}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Build a transcript-safe ApprovalLifecycleEntry from an ApprovalRecord.
 */
export function buildLifecycleEntry(
  record: ApprovalRecord,
  event: ApprovalLifecycleEvent,
  at: number,
): ApprovalLifecycleEntry {
  const entry: ApprovalLifecycleEntry = {
    type: 'approval_lifecycle',
    event,
    requestId: record.request.requestId,
    sessionId: record.request.sessionId,
    tool: record.request.tool,
    action: record.request.action,
    argSummary: record.request.argSummary,
    riskReason: record.request.riskReason,
    requestedAt: record.request.requestedAt,
    expiresAt: record.request.expiresAt,
    at,
  };
  if (record.resolution) {
    entry.resolution = {
      state: record.resolution.state,
      resolvedAt: record.resolution.resolvedAt,
    };
  }
  return entry;
}

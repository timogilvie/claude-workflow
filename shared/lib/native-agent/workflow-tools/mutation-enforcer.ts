/**
 * Policy-enforcing wrapper for workflow tool mutations (HOK-2359).
 *
 * enforceMutation provides a single entry point that:
 *   1. Checks isMutationAllowed() from the existing policy matrix before
 *      touching any external system.
 *   2. Returns a structured DeniedEnforcedResult (plain data) when blocked,
 *      without calling the executor.
 *   3. Calls the executor exactly once when the policy allows it.
 *   4. Calls the recorder exactly once on every path (denied, executed, failed).
 *   5. Surfaces recording errors to the caller — no silent drops.
 *
 * The executor and recorder are dependency-injected so tests can verify that
 * denial performs no side effects and that exactly one record is written per path.
 *
 * This module never duplicates phase logic — it delegates to the existing
 * isMutationAllowed() gate in mutation-policy.ts.
 */

import { isMutationAllowed } from './mutation-policy.ts';
import {
  createDeniedRecord,
  createExecutedRecord,
  createFailedRecord,
  type DeniedMutationRecord,
  type ExecutedMutationRecord,
  type FailedMutationRecord,
  type MutationRecorderFn,
} from './mutation-record.ts';
import type {
  WorkflowPhase,
  WorkflowToolName,
  WorkflowMutationAction,
  ExternalRef,
  IdempotencyOutcome,
} from './contracts.ts';

// ---------------------------------------------------------------------------
// Context and options
// ---------------------------------------------------------------------------

export interface MutationEnforcerContext {
  phase: WorkflowPhase;
  tool: WorkflowToolName;
  action: WorkflowMutationAction;
}

/**
 * Called after a successful execution to extract idempotency metadata for the
 * record. Returning undefined means no idempotency data is attached.
 */
export type IdempotencyExtractor<T> = (result: T) => {
  idempotencyKey?: string;
  idempotencyOutcome?: IdempotencyOutcome;
  ref?: ExternalRef | null;
} | undefined;

export interface EnforceMutationOptions<T> {
  context: MutationEnforcerContext;
  /** The actual mutation — called at most once, only when policy allows. */
  executor: () => Promise<T>;
  /** Receives exactly one record per invocation on every path. */
  recorder: MutationRecorderFn;
  /** Optional: extract idempotency data from the executor result for the record. */
  extractIdempotency?: IdempotencyExtractor<T>;
  /** Override the wall-clock source (for deterministic tests). Defaults to Date.now. */
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DeniedEnforcedResult {
  readonly status: 'denied';
  readonly record: DeniedMutationRecord;
}

export interface ExecutedEnforcedResult<T> {
  readonly status: 'executed';
  readonly result: T;
  readonly record: ExecutedMutationRecord;
}

export interface FailedEnforcedResult {
  readonly status: 'failed';
  readonly error: unknown;
  readonly record: FailedMutationRecord;
}

export type EnforcedResult<T> =
  | DeniedEnforcedResult
  | ExecutedEnforcedResult<T>
  | FailedEnforcedResult;

// ---------------------------------------------------------------------------
// Core enforcer
// ---------------------------------------------------------------------------

/**
 * Enforce the mutation policy for a single (phase, tool, action) operation.
 *
 * Guarantees (see module docstring for the full list).
 */
export async function enforceMutation<T>(
  options: EnforceMutationOptions<T>,
): Promise<EnforcedResult<T>> {
  const { context, executor, recorder, extractIdempotency, clock = Date.now } = options;
  const { phase, tool, action } = context;

  const policyResult = isMutationAllowed(phase, tool, action);
  const timestampMs = clock();

  if (!policyResult.allowed) {
    const record = createDeniedRecord(tool, phase, action, policyResult.reason, timestampMs);
    // executor is NOT called — no side effect occurs on denial.
    await recorder(record);
    return { status: 'denied', record };
  }

  let result: T;
  try {
    result = await executor();
  } catch (error: unknown) {
    const record = createFailedRecord(tool, phase, action, error, timestampMs);
    await recorder(record);
    return { status: 'failed', error, record };
  }

  const idempotencyExtras = extractIdempotency?.(result);
  const record = createExecutedRecord(
    tool,
    phase,
    action,
    policyResult.reason,
    timestampMs,
    idempotencyExtras,
  );
  await recorder(record);
  return { status: 'executed', result, record };
}

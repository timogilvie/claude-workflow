/**
 * Mutation outcome model for workflow tool enforcement (HOK-2359).
 *
 * Defines serializable record types for denied, executed, and failed mutation
 * paths. All shapes are plain data — no classes, no non-serializable fields —
 * so they can be embedded in transcript tool_result.details and dashboard events.
 *
 * Three invariants:
 * - A denied record is produced when the policy gate blocks the operation before
 *   any executor is invoked. No side effect has occurred.
 * - An executed record is produced when the executor completes successfully.
 * - A failed record is produced when the executor throws or rejects.
 *
 * The MutationRecorderFn is called exactly once per enforced invocation
 * (see mutation-enforcer.ts). Recording errors propagate to the caller;
 * silent drops are not allowed.
 */

import type {
  WorkflowPhase,
  WorkflowToolName,
  WorkflowMutationAction,
  ExternalRef,
  IdempotencyOutcome,
} from './contracts.ts';

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

/** A mutation the policy gate blocked before any side effect occurred. */
export interface DeniedMutationRecord {
  readonly outcome: 'denied';
  readonly tool: WorkflowToolName;
  readonly phase: WorkflowPhase;
  readonly action: WorkflowMutationAction;
  /** Stable denial reason from the policy matrix. Tests may assert the full value. */
  readonly reason: string;
  readonly timestampMs: number;
}

/** A mutation that was allowed by the policy gate and executed successfully. */
export interface ExecutedMutationRecord {
  readonly outcome: 'executed';
  readonly tool: WorkflowToolName;
  readonly phase: WorkflowPhase;
  readonly action: WorkflowMutationAction;
  /** Policy allow reason from the matrix. */
  readonly policyReason: string;
  readonly timestampMs: number;
  /** Idempotency key from the tool result, when available. */
  readonly idempotencyKey?: string;
  /** Idempotency outcome from the tool result, when available. */
  readonly idempotencyOutcome?: IdempotencyOutcome;
  /** Primary external reference from the tool result, when available. */
  readonly ref?: ExternalRef | null;
}

/** A mutation that was allowed but whose executor threw or rejected. */
export interface FailedMutationRecord {
  readonly outcome: 'failed';
  readonly tool: WorkflowToolName;
  readonly phase: WorkflowPhase;
  readonly action: WorkflowMutationAction;
  /** Normalized error string. Never contains raw stack traces or secret-bearing content. */
  readonly error: string;
  readonly timestampMs: number;
}

/** Union of all mutation outcome record types. */
export type MutationRecord = DeniedMutationRecord | ExecutedMutationRecord | FailedMutationRecord;

/**
 * Called exactly once per enforced mutation invocation.
 * If the recorder throws, the error is surfaced to the caller (no silent drops).
 */
export type MutationRecorderFn = (record: MutationRecord) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

export function createDeniedRecord(
  tool: WorkflowToolName,
  phase: WorkflowPhase,
  action: WorkflowMutationAction,
  reason: string,
  timestampMs: number,
): DeniedMutationRecord {
  return { outcome: 'denied', tool, phase, action, reason, timestampMs };
}

export function createExecutedRecord(
  tool: WorkflowToolName,
  phase: WorkflowPhase,
  action: WorkflowMutationAction,
  policyReason: string,
  timestampMs: number,
  extras?: {
    idempotencyKey?: string;
    idempotencyOutcome?: IdempotencyOutcome;
    ref?: ExternalRef | null;
  },
): ExecutedMutationRecord {
  return {
    outcome: 'executed',
    tool,
    phase,
    action,
    policyReason,
    timestampMs,
    ...extras,
  };
}

export function createFailedRecord(
  tool: WorkflowToolName,
  phase: WorkflowPhase,
  action: WorkflowMutationAction,
  error: unknown,
  timestampMs: number,
): FailedMutationRecord {
  return {
    outcome: 'failed',
    tool,
    phase,
    action,
    error: normalizeMutationError(error),
    timestampMs,
  };
}

/**
 * Normalize an unknown thrown value to a safe, non-secret string.
 * Strips stack traces. Uses .message if available.
 */
export function normalizeMutationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'unknown error';
}

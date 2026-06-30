import type { WorkflowMutationAction, WorkflowPhase, WorkflowToolName } from './contracts.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import {
  createApprovalNeededMutationRecord,
  createDeniedMutationRecord,
  createExecutedMutationRecord,
  createFailedMutationRecord,
  recordMutationOutcome,
  type MutationRecordContext,
  type MutationRecordSink,
  type MutationRecordWarningFn,
} from './mutation-record.ts';
import type { ApprovalGateFn } from './approval-gate.ts';

export interface MutationDeniedResult extends MutationRecordContext {
  allowed: false;
  outcome: 'denied';
  code: string;
  reason: string;
}

export interface MutationExecutedResult<TResult = unknown> extends MutationRecordContext {
  allowed: true;
  outcome: 'executed';
  result: TResult;
}

export interface MutationFailedResult extends MutationRecordContext {
  allowed: true;
  outcome: 'failed';
  code: 'external_error';
  reason: string;
  error: {
    name: string;
    message: string;
  };
}

/** Returned when a policy-allowed operation is paused pending human approval (HOK-2364). */
export interface MutationApprovalNeededResult extends MutationRecordContext {
  allowed: false;
  outcome: 'approval_needed';
  requestId: string;
  riskReason: string;
  argSummary: string;
  expiresAt: number;
}

export type EnforceMutationResult<TResult = unknown> =
  | MutationDeniedResult
  | MutationExecutedResult<TResult>
  | MutationFailedResult
  | MutationApprovalNeededResult;

export interface EnforceMutationRequest<TResult = unknown> extends MutationRecordContext {
  execute: () => TResult | Promise<TResult>;
  /**
   * Required mutation record sink. REQ-F4 mandates that every external mutation
   * outcome is recorded exactly once; the sink is the recording hook. Tests may
   * pass `async () => {}` as a no-op sink when the record is not asserted.
   */
  record: MutationRecordSink<TResult>;
  warn?: MutationRecordWarningFn;
  /**
   * Optional human-approval gate (HOK-2364).
   *
   * Called after policy allows the mutation, before execution. When the gate
   * returns a non-proceeding decision the mutation is paused or blocked without
   * calling execute(). Risk classification is the caller's responsibility; the
   * enforcer does not define or cache policy.
   */
  approvalGate?: ApprovalGateFn;
  /** Sanitized argument summary passed to the gate (no secrets). */
  argSummary?: string;
  /** Session identifier required when approvalGate is provided. */
  sessionId?: string;
}

export async function enforceMutation<TResult>(
  request: EnforceMutationRequest<TResult>,
): Promise<EnforceMutationResult<TResult>> {
  const context: MutationRecordContext = {
    tool: request.tool,
    phase: request.phase,
    action: request.action,
    target: request.target,
  };
  const policy = isMutationAllowed(request.phase, request.tool, request.action);

  if (!policy.allowed) {
    const denied: MutationDeniedResult = {
      ...context,
      allowed: false,
      outcome: 'denied',
      code: policy.code,
      reason: policy.reason,
    };
    await recordMutationOutcome(createDeniedMutationRecord(context, denied), {
      sink: request.record,
      warn: request.warn,
    });
    return denied;
  }

  // Check approval gate when provided (HOK-2364).
  if (request.approvalGate) {
    const sessionId = request.sessionId ?? '';
    const argSummary = request.argSummary ?? '';
    const decision = await request.approvalGate({
      sessionId,
      tool: request.tool,
      action: request.action,
      argSummary,
    });

    if (!decision.proceed) {
      if (decision.outcome === 'approval_needed') {
        const approvalNeededRecord = createApprovalNeededMutationRecord(context, {
          requestId: decision.requestId,
          riskReason: decision.riskReason,
          argSummary: decision.argSummary,
          expiresAt: decision.expiresAt,
        });
        await recordMutationOutcome(approvalNeededRecord, {
          sink: request.record as MutationRecordSink<unknown>,
          warn: request.warn,
        });
        const approvalNeeded: MutationApprovalNeededResult = {
          ...context,
          allowed: false,
          outcome: 'approval_needed',
          requestId: decision.requestId,
          riskReason: decision.riskReason,
          argSummary: decision.argSummary,
          expiresAt: decision.expiresAt,
        };
        return approvalNeeded;
      }

      // denied or expired — treat as a policy-level denial
      const code =
        decision.outcome === 'denied'
          ? 'approval_denied'
          : 'approval_expired';
      const denied: MutationDeniedResult = {
        ...context,
        allowed: false,
        outcome: 'denied',
        code,
        reason: decision.reason,
      };
      await recordMutationOutcome(createDeniedMutationRecord(context, denied), {
        sink: request.record,
        warn: request.warn,
      });
      return denied;
    }
  }

  try {
    const result = await request.execute();
    await recordMutationOutcome(createExecutedMutationRecord(context, result), {
      sink: request.record,
      warn: request.warn,
    });
    return {
      ...context,
      allowed: true,
      outcome: 'executed',
      result,
    };
  } catch (error) {
    const failedRecord = createFailedMutationRecord(context, error);
    await recordMutationOutcome(failedRecord, {
      sink: request.record,
      warn: request.warn,
    });
    return {
      ...context,
      allowed: true,
      outcome: 'failed',
      code: failedRecord.code,
      reason: failedRecord.reason,
      error: failedRecord.error,
    };
  }
}

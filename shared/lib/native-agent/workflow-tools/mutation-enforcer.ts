import type { WorkflowMutationAction, WorkflowPhase, WorkflowToolName } from './contracts.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import {
  createDeniedMutationRecord,
  createExecutedMutationRecord,
  createFailedMutationRecord,
  recordMutationOutcome,
  type MutationRecordContext,
  type MutationRecordSink,
  type MutationRecordWarningFn,
} from './mutation-record.ts';

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

export type EnforceMutationResult<TResult = unknown> =
  | MutationDeniedResult
  | MutationExecutedResult<TResult>
  | MutationFailedResult;

export interface EnforceMutationRequest<TResult = unknown> extends MutationRecordContext {
  execute: () => TResult | Promise<TResult>;
  /**
   * Required mutation record sink. REQ-F4 mandates that every external mutation
   * outcome is recorded exactly once; the sink is the recording hook. Tests may
   * pass `async () => {}` as a no-op sink when the record is not asserted.
   */
  record: MutationRecordSink<TResult>;
  warn?: MutationRecordWarningFn;
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

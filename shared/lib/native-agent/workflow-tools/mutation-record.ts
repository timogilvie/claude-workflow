import type { WorkflowMutationAction, WorkflowPhase, WorkflowToolName } from './contracts.ts';

export interface MutationRecordContext {
  tool: WorkflowToolName;
  phase: WorkflowPhase;
  action: WorkflowMutationAction;
  target?: Record<string, unknown>;
}

export interface MutationErrorSummary {
  name: string;
  message: string;
}

interface MutationRecordBase extends MutationRecordContext {
  outcome: 'executed' | 'denied' | 'failed';
}

export interface ExecutedMutationRecord<TResult = unknown> extends MutationRecordBase {
  outcome: 'executed';
  result: TResult;
}

export interface DeniedMutationRecord extends MutationRecordBase {
  outcome: 'denied';
  code: string;
  reason: string;
}

export interface FailedMutationRecord extends MutationRecordBase {
  outcome: 'failed';
  code: 'external_error';
  reason: string;
  error: MutationErrorSummary;
}

export type MutationRecord<TResult = unknown> =
  | ExecutedMutationRecord<TResult>
  | DeniedMutationRecord
  | FailedMutationRecord;

export type MutationRecordSink<TResult = unknown> = (
  record: MutationRecord<TResult>,
) => void | Promise<void>;

export type MutationRecordWarningFn = (message: string, error: unknown) => void;

export interface MutationRecorderOptions<TResult = unknown> {
  sink?: MutationRecordSink<TResult>;
  warn?: MutationRecordWarningFn;
}

export function summarizeMutationError(error: unknown): MutationErrorSummary {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
    };
  }

  return {
    name: 'NonError',
    message: typeof error === 'string' ? error : String(error),
  };
}

export function createExecutedMutationRecord<TResult>(
  context: MutationRecordContext,
  result: TResult,
): ExecutedMutationRecord<TResult> {
  return {
    ...context,
    outcome: 'executed',
    result,
  };
}

export function createDeniedMutationRecord(
  context: MutationRecordContext,
  denial: Pick<DeniedMutationRecord, 'code' | 'reason'>,
): DeniedMutationRecord {
  return {
    ...context,
    outcome: 'denied',
    code: denial.code,
    reason: denial.reason,
  };
}

export function createFailedMutationRecord(
  context: MutationRecordContext,
  error: unknown,
): FailedMutationRecord {
  const summary = summarizeMutationError(error);
  return {
    ...context,
    outcome: 'failed',
    code: 'external_error',
    reason: `${context.tool} failed: ${summary.message}`,
    error: summary,
  };
}

export async function recordMutationOutcome<TResult>(
  record: MutationRecord<TResult>,
  options: MutationRecorderOptions<TResult> = {},
): Promise<void> {
  if (options.sink === undefined) {
    return;
  }

  try {
    await options.sink(record);
  } catch (error) {
    const warn = options.warn ?? defaultMutationRecordWarning;
    warn(
      `[workflow-tools] Failed to record mutation outcome for ${record.tool}/${record.outcome}`,
      error,
    );
  }
}

function defaultMutationRecordWarning(message: string, error: unknown): void {
  console.warn(`${message}: ${String(error)}`);
}

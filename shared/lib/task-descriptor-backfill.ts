import type { EvalRecord, TaskDescriptor } from './eval-schema.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';

export type TaskDescriptorBackfillSkipReason =
  | 'already_has_descriptor'
  | 'missing_original_prompt';

export interface TaskDescriptorBackfillResult {
  record: EvalRecord;
  changed: boolean;
  skipReason?: TaskDescriptorBackfillSkipReason;
}

export function buildTaskDescriptorFromEvalRecord(
  record: Pick<
    EvalRecord,
    | 'originalPrompt'
    | 'taskContext'
    | 'repoContext'
    | 'difficultySignals'
    | 'routingDecision'
    | 'stageOutcomes'
    | 'workflowCost'
    | 'workflowTokenUsage'
    | 'score'
    | 'timeSeconds'
    | 'interventionCount'
    | 'interventions'
  >,
): TaskDescriptor | null {
  if (typeof record.originalPrompt !== 'string' || record.originalPrompt.trim() === '') {
    return null;
  }

  return buildTaskDescriptor({
    originalPrompt: record.originalPrompt,
    taskContext: record.taskContext || undefined,
    repoContext: record.repoContext || undefined,
    difficultySignals: record.difficultySignals || undefined,
    routingDecision: record.routingDecision || undefined,
    stageOutcomes: record.stageOutcomes || undefined,
    workflowCost: record.workflowCost || undefined,
    workflowTokenUsage: record.workflowTokenUsage || undefined,
    score: record.score,
    timeSeconds: record.timeSeconds,
    interventionCount: record.interventionCount,
    interventions: record.interventions || undefined,
  });
}

export function backfillTaskDescriptorRecord(record: EvalRecord): TaskDescriptorBackfillResult {
  if (record.taskDescriptor) {
    return {
      record,
      changed: false,
      skipReason: 'already_has_descriptor',
    };
  }

  const descriptor = buildTaskDescriptorFromEvalRecord(record);
  if (!descriptor) {
    return {
      record,
      changed: false,
      skipReason: 'missing_original_prompt',
    };
  }

  return {
    record: {
      ...record,
      taskDescriptor: descriptor,
    },
    changed: true,
  };
}

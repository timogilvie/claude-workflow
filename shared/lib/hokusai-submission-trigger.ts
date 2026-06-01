import { getHokusaiSubmissionConfig } from './config.ts';
import { buildSubmitDataContributionRow, type RedactedEvalContributionProjection } from './hokusai-contribution-builder.ts';
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution } from './hokusai-queue.ts';
import { redactHokusaiSubmission } from './hokusai-redaction.ts';
import { toHokusaiSubmission, type HokusaiSubmission } from './hokusai-schema.ts';
import { errorMessage } from './error-utils.ts';
import type { EvalRecord } from './eval-schema.ts';

export interface TriggerHokusaiSubmissionOptions {
  repoDir: string;
  configDir?: string;
  redactionSalt?: string;
}

export const hokusaiSubmissionTriggerDeps = {
  getHokusaiSubmissionConfig,
  toHokusaiSubmission,
  redactHokusaiSubmission,
  buildSubmitDataContributionRow,
  enqueueContribution,
  drainContributionQueue,
};

function toBudgetCompliant(submission: HokusaiSubmission): boolean {
  const maxCostUsd = submission.constraints.max_cost_usd;
  if (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd)) {
    return true;
  }
  return submission.observed_outcomes.actual_cost_usd <= maxCostUsd;
}

function toContributionProjection(submission: HokusaiSubmission, observedAt: string): RedactedEvalContributionProjection {
  const projection: RedactedEvalContributionProjection = {
    taskId: submission.task_id,
    runId: submission.run_id,
    harness: 'wavemill',
    observedAt,
    observedSuccess: submission.observed_outcomes.completed_successfully,
    budgetCompliant: toBudgetCompliant(submission),
    actualCostUsd: submission.observed_outcomes.actual_cost_usd,
    wallClockSeconds: submission.observed_outcomes.actual_time_seconds ?? undefined,
    inputs: {
      schema_version: submission.schema_version,
      planner_model: submission.route_taken.planner_model,
      coder_model: submission.route_taken.coder_model,
      reviewer_model: submission.route_taken.reviewer_model,
      intervention_count: submission.observed_outcomes.intervention_count,
      rubric_version: submission.rubric_signals?.rubric_version,
      rubric_mean_score: submission.rubric_signals?.mean_score,
      determinative_boundary: submission.rubric_signals?.determinative_boundary,
    },
  };

  return projection;
}

function warnHokusai(message: string, error: unknown): void {
  console.warn(`[hokusai] ${message}: ${errorMessage(error)}`);
}

/**
 * Best-effort Hokusai submission trigger for completed eval records.
 *
 * The eval path should call this after persistence and should not await it.
 * All failures are downgraded to warnings so evaluation completion remains
 * reliable even when config, redaction, queueing, or drain behavior changes.
 */
export async function triggerHokusaiSubmission(
  record: EvalRecord,
  options: TriggerHokusaiSubmissionOptions,
): Promise<void> {
  try {
    const config = hokusaiSubmissionTriggerDeps.getHokusaiSubmissionConfig(options.repoDir);
    if (config.enabled !== true) {
      return;
    }

    const submissionResult = hokusaiSubmissionTriggerDeps.toHokusaiSubmission(record);
    if (!submissionResult.ok) {
      return;
    }

    const redactedSubmission = hokusaiSubmissionTriggerDeps.redactHokusaiSubmission(submissionResult.submission, {
      configDir: options.configDir,
      salt: options.redactionSalt,
    });
    const row = hokusaiSubmissionTriggerDeps.buildSubmitDataContributionRow(
      toContributionProjection(redactedSubmission, record.timestamp),
    );
    const enqueueResult = await hokusaiSubmissionTriggerDeps.enqueueContribution(row, {
      repoDir: options.repoDir,
      configDir: options.configDir,
    });

    if (enqueueResult.status !== 'enqueued') {
      return;
    }

    void hokusaiSubmissionTriggerDeps.drainContributionQueue({
      repoDir: options.repoDir,
      configDir: options.configDir,
    }).catch((error) => {
      warnHokusai('opportunistic drain failed', error);
    });
  } catch (error) {
    warnHokusai('submission trigger failed', error);
  }
}

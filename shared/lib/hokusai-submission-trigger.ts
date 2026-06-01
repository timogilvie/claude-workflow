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

export type HokusaiSubmissionTriggerResult =
  | { status: 'disabled' }
  | { status: 'not_eligible'; reasons: string[] }
  | { status: 'enqueued'; entryId?: string; drainStarted: boolean }
  | { status: 'duplicate'; drainStarted: false }
  | { status: 'failed'; error: string };

export function formatHokusaiSubmissionTriggerResult(result: HokusaiSubmissionTriggerResult): string {
  switch (result.status) {
    case 'disabled':
      return 'disabled';
    case 'not_eligible':
      return `not eligible (${result.reasons.join(', ') || 'no reason provided'})`;
    case 'enqueued':
      return `enqueued${result.entryId ? ` entry=${result.entryId}` : ''}${result.drainStarted ? ' drain=started' : ''}`;
    case 'duplicate':
      return 'duplicate';
    case 'failed':
      return `failed (${result.error})`;
  }
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
  const actualCostUsd = submission.observed_outcomes.actual_cost_usd;
  if (typeof actualCostUsd !== 'number' || !Number.isFinite(actualCostUsd)) {
    return false;
  }

  const maxCostUsd = submission.constraints.max_cost_usd;
  if (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd)) {
    return true;
  }
  return actualCostUsd <= maxCostUsd;
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
 * The eval path should call this after persistence and await the enqueue
 * attempt. Upload is intentionally detached so evaluation completion remains
 * independent from endpoint latency or transient service failures.
 */
export async function triggerHokusaiSubmission(
  record: EvalRecord,
  options: TriggerHokusaiSubmissionOptions,
): Promise<HokusaiSubmissionTriggerResult> {
  try {
    const config = hokusaiSubmissionTriggerDeps.getHokusaiSubmissionConfig(options.repoDir);
    if (config.enabled !== true) {
      return { status: 'disabled' };
    }

    const submissionResult = hokusaiSubmissionTriggerDeps.toHokusaiSubmission(record);
    if (!submissionResult.ok) {
      return { status: 'not_eligible', reasons: submissionResult.reasons };
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
      return { status: enqueueResult.status, drainStarted: false };
    }

    void hokusaiSubmissionTriggerDeps.drainContributionQueue({
      repoDir: options.repoDir,
      configDir: options.configDir,
    }).catch((error) => {
      warnHokusai('opportunistic drain failed', error);
    });
    return {
      status: 'enqueued',
      entryId: enqueueResult.entry?.entryId,
      drainStarted: true,
    };
  } catch (error) {
    warnHokusai('submission trigger failed', error);
    return { status: 'failed', error: errorMessage(error) };
  }
}

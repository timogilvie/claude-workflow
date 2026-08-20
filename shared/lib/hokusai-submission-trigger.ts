import { getHokusaiSubmissionConfig } from './config.ts';
import { buildSubmitDataContributionRow, type RedactedEvalContributionProjection } from './hokusai-contribution-builder.ts';
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution } from './hokusai-queue.ts';
import { formatConsentBlockers, type ConsentBlocker } from './hokusai-consent.ts';
import { recordTriggerOutcome } from './hokusai-trigger-stats.ts';
import { redactHokusaiSubmission } from './hokusai-redaction.ts';
import { toHokusaiSubmission, type HokusaiSubmission } from './hokusai-schema.ts';
import { errorMessage } from './error-utils.ts';
import type { EvalRecord } from './eval-schema.ts';

export interface TriggerHokusaiSubmissionOptions {
  repoDir: string;
  configDir?: string;
  redactionSalt?: string;
  launchPriorityValidation?: LaunchPriorityValidationContext;
}

export type HokusaiSubmissionTriggerResult =
  | { status: 'disabled'; reason: string; blockers?: ConsentBlocker[] }
  | { status: 'not_eligible'; reasons: string[] }
  | { status: 'enqueued'; entryId?: string; drainStarted: boolean }
  | { status: 'duplicate'; drainStarted: false }
  | { status: 'failed'; error: string };

export function formatHokusaiSubmissionTriggerResult(result: HokusaiSubmissionTriggerResult): string {
  switch (result.status) {
    case 'disabled':
      return `disabled (${result.reason})`;
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

export interface LaunchPriorityValidationContext {
  catalogGeneratedAt?: string;
  catalogSourceHash?: string;
  launchPriorityListVersion?: string;
  launchPriorityFixtureHash?: string;
}

function toLaunchPriorityInputs(
  launchPriorityValidation: LaunchPriorityValidationContext | undefined,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (launchPriorityValidation?.catalogGeneratedAt) {
    inputs.launch_priority_catalog_generated_at = launchPriorityValidation.catalogGeneratedAt;
  }
  if (launchPriorityValidation?.catalogSourceHash) {
    inputs.launch_priority_catalog_source_hash = launchPriorityValidation.catalogSourceHash;
  }
  if (launchPriorityValidation?.launchPriorityListVersion) {
    inputs.launch_priority_list_version = launchPriorityValidation.launchPriorityListVersion;
  }
  if (launchPriorityValidation?.launchPriorityFixtureHash) {
    inputs.launch_priority_fixture_hash = launchPriorityValidation.launchPriorityFixtureHash;
  }
  return inputs;
}

export function buildHokusaiContributionProjection(
  submission: HokusaiSubmission,
  observedAt: string,
  record?: EvalRecord,
  launchPriorityValidation?: LaunchPriorityValidationContext,
): RedactedEvalContributionProjection {
  const fod = record?.featureOutcomeDiagnostics ?? undefined;

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
      ...(record?.attempted_model
        ? { coder_attempted_model: record.attempted_model }
        : {}),
      ...(record?.model_alias
        ? { coder_model_alias: record.model_alias }
        : {}),
      ...toLaunchPriorityInputs(launchPriorityValidation),
    },
    // Feature outcome artifact diagnostics (HOK-2262)
    // Only safe scalar/enum/array-of-string fields; no raw paths or issue IDs
    ...(fod?.eligibilityDiagnostic !== undefined
      ? { outcomeDiagnostic: fod.eligibilityDiagnostic }
      : {}),
    ...(fod !== undefined
      ? {
        outcomeSource: (
          fod.used
            ? 'feature_outcome_artifact'
            : fod.present
              ? 'unknown'
              : 'reconstructed'
        ) as const,
      }
      : {}),
    ...(fod !== undefined
      ? { outcomeArtifactPresent: fod.present }
      : {}),
    ...(fod !== undefined
      ? { outcomeArtifactValid: fod.valid }
      : {}),
    ...(fod !== undefined
      ? { outcomeArtifactUsed: fod.used }
      : {}),
    ...(fod?.missingFields !== undefined
      ? { outcomeMissingFields: fod.missingFields }
      : {}),
    ...(fod?.invalidFields !== undefined
      ? { outcomeInvalidFields: fod.invalidFields }
      : {}),
    ...(fod?.reason !== undefined && fod.reason !== 'loaded'
      ? { outcomeFailureReason: fod.reason }
      : {}),
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
  let result: HokusaiSubmissionTriggerResult | null = null;

  try {
    const config = hokusaiSubmissionTriggerDeps.getHokusaiSubmissionConfig(options.repoDir);
    if (config.enabled !== true) {
      const value = config.enabled === undefined ? 'unset' : String(config.enabled);
      const reason = `hokusai.dataSubmission.enabled=${value} (repo config for ${options.repoDir})`;
      result = { status: 'disabled', reason };
    } else {
      const submissionResult = hokusaiSubmissionTriggerDeps.toHokusaiSubmission(record);
      if (!submissionResult.ok) {
        result = { status: 'not_eligible', reasons: submissionResult.reasons };
      } else {
        const redactedSubmission = hokusaiSubmissionTriggerDeps.redactHokusaiSubmission(submissionResult.submission, {
          configDir: options.configDir,
          salt: options.redactionSalt,
        });
        const row = hokusaiSubmissionTriggerDeps.buildSubmitDataContributionRow(
          buildHokusaiContributionProjection(
            redactedSubmission,
            record.timestamp,
            record,
            options.launchPriorityValidation,
          ),
        );
        const enqueueResult = await hokusaiSubmissionTriggerDeps.enqueueContribution(row, {
          repoDir: options.repoDir,
          configDir: options.configDir,
        });

        if (enqueueResult.status === 'duplicate') {
          result = { status: 'duplicate', drainStarted: false };
        } else if (enqueueResult.status === 'disabled') {
          const blockersText = formatConsentBlockers(enqueueResult.blockers ?? []);
          const reason = blockersText || 'unknown reason';
          console.warn(
            `[hokusai] CONFIG CONFLICT: hokusai.dataSubmission.enabled=true in repo config but submission is blocked by: ${blockersText}`,
          );
          result = { status: 'disabled', reason, blockers: enqueueResult.blockers };
        } else if (enqueueResult.status === 'enqueued') {
          void hokusaiSubmissionTriggerDeps.drainContributionQueue({
            repoDir: options.repoDir,
            configDir: options.configDir,
          }).catch((error) => {
            warnHokusai('opportunistic drain failed', error);
          });
          result = {
            status: 'enqueued',
            entryId: enqueueResult.entry?.entryId,
            drainStarted: true,
          };
        } else {
          result = { status: enqueueResult.status, drainStarted: false };
        }
      }
    }

    if (!result) {
      result = { status: 'failed', error: 'Unknown error' };
    }
  } catch (error) {
    warnHokusai('submission trigger failed', error);
    result = { status: 'failed', error: errorMessage(error) };
  }

  await recordTriggerOutcome(result, { repoDir: options.repoDir });
  return result;
}

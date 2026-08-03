/**
 * Verification telemetry export and redaction.
 *
 * Provides functions to redact verification telemetry for Hokasai export:
 * - Removes: raw command logs, operator override details
 * - Preserves: summary stats, failure category, timestamps, durations
 *
 * Rationale: Keep metrics signals while hiding implementation details and secrets.
 *
 * @module verification-telemetry-export
 */

import type { EvalRecord } from './eval-schema.ts';
import type { VerificationTelemetry } from './verification-telemetry-types.ts';

/**
 * Redact verification telemetry for export.
 * Removes: raw command logs, operator override details
 * Preserves: summary stats, failure category, timestamps, durations
 *
 * Rationale: Keep metrics signals while hiding implementation details and secrets.
 */
export function redactVerificationTelemetry(
  telemetry: VerificationTelemetry,
): VerificationTelemetry {
  const redacted: VerificationTelemetry = {};

  // Preserve: contract source/version (needed for segmentation)
  if (telemetry.contractSource) {
    redacted.contractSource = telemetry.contractSource;
  }
  if (telemetry.contractVersion) {
    redacted.contractVersion = telemetry.contractVersion;
  }

  // Preserve: SHAs for traceability (not sensitive)
  if (telemetry.verifiedHeadSha) {
    redacted.verifiedHeadSha = telemetry.verifiedHeadSha;
  }
  if (telemetry.verifiedBaseSha) {
    redacted.verifiedBaseSha = telemetry.verifiedBaseSha;
  }

  // Preserve: timestamps (needed for time-to-green calculation)
  if (telemetry.startedAt) {
    redacted.startedAt = telemetry.startedAt;
  }
  if (telemetry.completedAt) {
    redacted.completedAt = telemetry.completedAt;
  }

  // REDACT: raw command details, keep count only
  if (telemetry.commands) {
    redacted.commands = telemetry.commands.map((cmd) => ({
      index: cmd.index,
      // Redact: commandName (might contain sensitive args)
      commandName: '[redacted]',
      status: cmd.status,
      // Preserve: duration (needed for performance analysis)
      durationMs: cmd.durationMs,
      // Redact: failure reason
      failureReason: undefined,
    }));
  }

  // Preserve: summary (needed for metrics)
  if (telemetry.summary) {
    redacted.summary = {
      totalCommands: telemetry.summary.totalCommands,
      passedCommands: telemetry.summary.passedCommands,
      failedCommands: telemetry.summary.failedCommands,
      timeoutCommands: telemetry.summary.timeoutCommands,
      overallStatus: telemetry.summary.overallStatus,
      totalTimeSeconds: telemetry.summary.totalTimeSeconds,
      // Redact: wasOverridden (local-only business logic)
      wasOverridden: undefined,
    };
  }

  // Preserve: CI verdict (needed for first-green-CI metric)
  if (telemetry.firstCiVerdict) {
    redacted.firstCiVerdict = {
      startedAt: telemetry.firstCiVerdict.startedAt,
      concludedAt: telemetry.firstCiVerdict.concludedAt,
      status: telemetry.firstCiVerdict.status,
      timeToVerdictSeconds: telemetry.firstCiVerdict.timeToVerdictSeconds,
      // Redact: run IDs, logs URLs
      workflowRunId: undefined,
      ciLogsUrl: undefined,
    };
  }

  // Preserve: failure category (needed for failure analysis)
  if (telemetry.failedCheckFingerprint) {
    redacted.failedCheckFingerprint = telemetry.failedCheckFingerprint;
  }
  if (telemetry.failureCategory) {
    redacted.failureCategory = telemetry.failureCategory;
  }
  if (typeof telemetry.remoteOnlyFailure === 'boolean') {
    redacted.remoteOnlyFailure = telemetry.remoteOnlyFailure;
  }

  // Preserve: remediation counts/outcomes (needed for remediation metric)
  if (telemetry.remediation) {
    redacted.remediation = telemetry.remediation.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      // Redact: description
      description: '[redacted]',
      outcome: attempt.outcome,
      // Preserve: timing (needed for mean-time-to-remediation)
      delaySeconds: attempt.delaySeconds,
      durationSeconds: attempt.durationSeconds,
    }));
  }

  // REDACT: operator override entirely (local-only decision)
  // redacted.operatorOverride is intentionally omitted

  return redacted;
}

/**
 * Project eval record for export with redacted verification telemetry.
 * Includes verification telemetry (redacted) in the exported record.
 */
export function projectForExport(record: EvalRecord): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: record.id,
    schemaVersion: record.schemaVersion,
    originalPrompt: record.originalPrompt,
    modelId: record.modelId,
    modelVersion: record.modelVersion,
    score: record.score,
    scoreBand: record.scoreBand,
    timeSeconds: record.timeSeconds,
    timestamp: record.timestamp,
    interventionRequired: record.interventionRequired,
    interventionCount: record.interventionCount,
    interventionDetails: record.interventionDetails,
    rationale: record.rationale,
  };

  // Include optional fields if present
  if (record.issueId) projected.issueId = record.issueId;
  if (record.prUrl) projected.prUrl = record.prUrl;
  if (record.agentType) projected.agentType = record.agentType;
  if (record.workflowCost !== undefined) projected.workflowCost = record.workflowCost;
  if (record.pricingSnapshot) projected.pricingSnapshot = record.pricingSnapshot;
  if (record.difficultyBand) projected.difficultyBand = record.difficultyBand;
  if (record.difficultySignals) projected.difficultySignals = record.difficultySignals;
  if (record.stratum) projected.stratum = record.stratum;
  if (record.taskContext) projected.taskContext = record.taskContext;
  if (record.repoContext) projected.repoContext = record.repoContext;
  if (record.outcomes) projected.outcomes = record.outcomes;
  if (record.routingDecision) projected.routingDecision = record.routingDecision;
  if (record.stageOutcomes) projected.stageOutcomes = record.stageOutcomes;
  if (record.rubricEval) projected.rubricEval = record.rubricEval;
  if (record.tokenUsage) projected.tokenUsage = record.tokenUsage;

  // Include verification telemetry with redaction applied
  if (record.verificationTelemetry) {
    projected.verificationTelemetry = redactVerificationTelemetry(record.verificationTelemetry);
  }

  return projected;
}

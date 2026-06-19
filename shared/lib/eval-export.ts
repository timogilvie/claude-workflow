/**
 * Eval dataset export — flatten, redact, and serialize eval records
 * for ML training pipelines (router model training).
 *
 * Supports CSV and JSONL output formats with optional anonymization.
 *
 * @module eval-export
 */

import type { EvalRecord } from './eval-schema.ts';
import { redactText } from './text-redaction.ts';
export { redactText } from './text-redaction.ts';

// ────────────────────────────────────────────────────────────────
// Export Row Schema
// ────────────────────────────────────────────────────────────────

/** A single flat row suitable for ML training. */
export interface ExportRow {
  id: string;
  timestamp: string;

  // Prompt features
  prompt_text: string;
  prompt_length: number;
  prompt_word_count: number;
  prompt_line_count: number;

  // Model
  model_id: string;
  model_version: string;

  // Outcome (target variable)
  score: number;
  score_band: string;

  // Timing
  time_seconds: number | null;
  planning_time_seconds: number | null;
  coding_time_seconds: number | null;
  review_time_seconds: number | null;

  // Intervention signals
  intervention_required: boolean;
  intervention_count: number;
  intervention_details: string;
  interventions: string;

  // Judge metadata
  judge_model: string;
  judge_provider: string;
  rationale: string;

  // Task context
  issue_id: string;
  pr_url: string;

  // Cost
  workflow_cost: number | null;
  workflow_cost_status: string;

  // Complexity signals (from metadata when available)
  files_changed: number | null;
  lines_added: number | null;
  lines_removed: number | null;

  // Routing decision (HOK-775)
  routing_decision: string;
  route_prediction: string;
  route_calibration: string;
  resource_variants: string;
  router_resource_variant: string;
  planner_prompt_variant: string;
  reviewer_prompt_variant: string;
  rubric_provenance: string;
  rubric_completeness: number | null;
  rubric_correctness: number | null;
  rubric_code_quality: number | null;
  rubric_intervention_impact: number | null;
  rubric_autonomy: number | null;
  rubric_determinative_boundary: string;

  // Feature outcome diagnostics (HOK-2262)
  feature_outcome_present: boolean | null;
  feature_outcome_valid: boolean | null;
  feature_outcome_used: boolean | null;
  feature_outcome_source: string;
  feature_outcome_source_hash: string;
  feature_outcome_missing_fields: string;
  feature_outcome_conflict: boolean | null;
  outcome_source: string;
  outcome_eligibility_reason: string;
}

/** Column order for CSV output. */
const COLUMNS: (keyof ExportRow)[] = [
  'id',
  'timestamp',
  'prompt_text',
  'prompt_length',
  'prompt_word_count',
  'prompt_line_count',
  'model_id',
  'model_version',
  'score',
  'score_band',
  'time_seconds',
  'planning_time_seconds',
  'coding_time_seconds',
  'review_time_seconds',
  'intervention_required',
  'intervention_count',
  'intervention_details',
  'interventions',
  'judge_model',
  'judge_provider',
  'rationale',
  'issue_id',
  'pr_url',
  'workflow_cost',
  'workflow_cost_status',
  'files_changed',
  'lines_added',
  'lines_removed',
  'routing_decision',
  'route_prediction',
  'route_calibration',
  'resource_variants',
  'router_resource_variant',
  'planner_prompt_variant',
  'reviewer_prompt_variant',
  'rubric_provenance',
  'rubric_completeness',
  'rubric_correctness',
  'rubric_code_quality',
  'rubric_intervention_impact',
  'rubric_autonomy',
  'rubric_determinative_boundary',
  'feature_outcome_present',
  'feature_outcome_valid',
  'feature_outcome_used',
  'feature_outcome_source',
  'feature_outcome_source_hash',
  'feature_outcome_missing_fields',
  'feature_outcome_conflict',
  'outcome_source',
  'outcome_eligibility_reason',
];

// ────────────────────────────────────────────────────────────────
// Flatten
// ────────────────────────────────────────────────────────────────

export interface FlattenOptions {
  redact?: boolean;
}

function summarizeResourceVariants(record: EvalRecord): {
  all: string;
  router: string;
  planner: string;
  reviewer: string;
} {
  const selections = record.resourceSelections || [];
  const findVariant = (surface: 'router' | 'planner' | 'reviewer') =>
    selections.find((selection) => selection.surface === surface)?.variant || '';

  return {
    all: selections.length > 0 ? JSON.stringify(selections) : '',
    router: findVariant('router'),
    planner: findVariant('planner'),
    reviewer: findVariant('reviewer'),
  };
}

/** Flatten an EvalRecord into a flat ExportRow for ML consumption. */
export function flattenRecord(
  record: EvalRecord,
  options?: FlattenOptions,
): ExportRow {
  const redact = options?.redact ?? false;

  const promptText = redact
    ? redactText(record.originalPrompt)
    : record.originalPrompt;

  const rationaleText = redact
    ? redactText(record.rationale)
    : record.rationale;

  // Extract complexity signals from metadata
  const meta = record.metadata ?? {};
  const filesChanged = typeof meta.filesChanged === 'number' ? meta.filesChanged : null;
  const linesAdded = typeof meta.linesAdded === 'number' ? meta.linesAdded : null;
  const linesRemoved = typeof meta.linesRemoved === 'number' ? meta.linesRemoved : null;
  const resourceVariants = summarizeResourceVariants(record);
  const rubric = record.rubricEval;

  const timeSeconds =
    typeof record.timeSeconds === 'number' && Number.isFinite(record.timeSeconds) && record.timeSeconds >= 0
      ? record.timeSeconds
      : null;

  return {
    id: record.id,
    timestamp: record.timestamp,

    prompt_text: promptText,
    prompt_length: record.originalPrompt.length,
    prompt_word_count: record.originalPrompt.split(/\s+/).filter(Boolean).length,
    prompt_line_count: record.originalPrompt.split('\n').length,

    model_id: record.modelId,
    model_version: record.modelVersion,

    score: record.score,
    score_band: record.scoreBand,

    time_seconds: timeSeconds,
    planning_time_seconds: record.phaseDurationsSeconds?.planning ?? null,
    coding_time_seconds: record.phaseDurationsSeconds?.coding ?? null,
    review_time_seconds: record.phaseDurationsSeconds?.review ?? null,

    intervention_required: record.interventionRequired,
    intervention_count: record.interventionCount,
    intervention_details: JSON.stringify(record.interventionDetails),
    interventions: JSON.stringify(record.interventions || []),

    judge_model: record.judgeModel ?? '',
    judge_provider: record.judgeProvider ?? '',
    rationale: rationaleText,

    issue_id: record.issueId ?? '',
    pr_url: record.prUrl ?? '',

    workflow_cost: record.workflowCost ?? null,
    workflow_cost_status: record.workflowCostStatus ?? '',

    files_changed: filesChanged,
    lines_added: linesAdded,
    lines_removed: linesRemoved,

    routing_decision: record.routingDecision
      ? JSON.stringify(record.routingDecision)
      : '',
    route_prediction: record.routePrediction
      ? JSON.stringify(record.routePrediction)
      : '',
    route_calibration: record.routeCalibration
      ? JSON.stringify(record.routeCalibration)
      : '',
    resource_variants: resourceVariants.all,
    router_resource_variant: resourceVariants.router,
    planner_prompt_variant: resourceVariants.planner,
    reviewer_prompt_variant: resourceVariants.reviewer,
    rubric_provenance: record.rubric_provenance ?? '',
    rubric_completeness: rubric?.criteria.completeness.score ?? null,
    rubric_correctness: rubric?.criteria.correctness.score ?? null,
    rubric_code_quality: rubric?.criteria.code_quality.score ?? null,
    rubric_intervention_impact: rubric?.criteria.intervention_impact.score ?? null,
    rubric_autonomy: rubric?.criteria.autonomy.score ?? null,
    rubric_determinative_boundary: rubric?.determinative_boundary ?? '',

    // Feature outcome diagnostics (HOK-2262)
    feature_outcome_present: record.featureOutcome?.present ?? null,
    feature_outcome_valid: record.featureOutcome?.valid ?? null,
    feature_outcome_used: record.featureOutcome?.used ?? null,
    feature_outcome_source: record.featureOutcome?.source ?? '',
    feature_outcome_source_hash: record.featureOutcome?.sourceHash ?? '',
    feature_outcome_missing_fields: record.featureOutcome?.missingFields?.length
      ? JSON.stringify(record.featureOutcome.missingFields)
      : '',
    feature_outcome_conflict: record.featureOutcome?.conflictWithReconstructed ?? null,
    outcome_source: record.outcomeSource ?? '',
    outcome_eligibility_reason: record.outcomeEligibilityReason ?? '',
  };
}

// ────────────────────────────────────────────────────────────────
// CSV Writer
// ────────────────────────────────────────────────────────────────

/** Escape a field value for CSV (RFC 4180). */
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/** Serialize rows as CSV with header. */
export function toCsv(rows: ExportRow[]): string {
  const header = COLUMNS.join(',');
  const dataLines = rows.map((row) =>
    COLUMNS.map((col) => escapeCsvField(row[col])).join(','),
  );
  return [header, ...dataLines].join('\n') + '\n';
}

// ────────────────────────────────────────────────────────────────
// JSONL Writer
// ────────────────────────────────────────────────────────────────

/** Serialize rows as JSONL (one JSON object per line). */
export function toJsonl(rows: ExportRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

// ────────────────────────────────────────────────────────────────
// Main Export Function
// ────────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'jsonl';

export interface ExportOptions {
  format: ExportFormat;
  records: EvalRecord[];
  redact?: boolean;
}

/**
 * Export eval records as a training-ready dataset.
 *
 * @returns Serialized string in the requested format
 */
export function exportEvalDataset(options: ExportOptions): string {
  const rows = options.records.map((r) =>
    flattenRecord(r, { redact: options.redact }),
  );

  switch (options.format) {
    case 'csv':
      return toCsv(rows);
    case 'jsonl':
      return toJsonl(rows);
    default:
      throw new Error(`Unsupported format: ${options.format}`);
  }
}

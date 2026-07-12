/**
 * Validation for redacted Hokusai contribution rows.
 *
 * Queue payloads must only contain already-redacted contribution shapes.
 *
 * The canonical schema now lives in `@hokusai/core`; this module is a thin
 * re-export shim that preserves wavemill's historical public surface so every
 * existing importer keeps working unchanged.
 *
 * @module hokusai-contribution-schema
 */

export {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
  COST_BUCKET_THRESHOLDS_USD,
  TIME_BUCKET_THRESHOLDS_SECONDS,
  ContributionValidationError,
  isSubmitDataContributionRow,
  isTechnicalTaskRouterContributionRowV2,
  validateContributionRow,
} from '@hokusai/core';

export type {
  SubmitDataContributionRow,
  TechnicalTaskRouterSelectedModels,
  TechnicalTaskRouterContributionRowV1,
  RoleAvailableModels,
  OutcomeLabels,
  CandidatePoolMetadata,
  SparseCellMetadata,
  TechnicalTaskRouterContributionRowV2,
  ContributionRow,
} from '@hokusai/core';

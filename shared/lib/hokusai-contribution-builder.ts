/**
 * Build redacted Hokusai contribution rows from safe Wavemill projections.
 *
 * The canonical builder now lives in `@hokusai/core`; this module is a thin
 * re-export shim that preserves wavemill's historical public surface so every
 * existing importer keeps working unchanged.
 *
 * @module hokusai-contribution-builder
 */

export {
  deriveOutcomeLabels,
  buildSubmitDataContributionRow,
  buildTechnicalTaskRouterContributionRow,
  buildTechnicalTaskRouterContributionRowV2,
} from '@hokusai/core';

export type {
  FeatureOutcomeDiagnosticProjection,
  RedactedEvalContributionProjection,
  RedactedEvalContributionProjectionV2,
} from '@hokusai/core';

/**
 * Native certification phase filter for router stage-pool filtering.
 *
 * Maps router stages to required certification phases and provides
 * fail-closed eligibility checking for native models in workflow routing.
 * Non-native models pass through unconditionally.
 *
 * @module native-agent/certification/phase-filter
 */

import { checkCertificationEligibility, type IneligibilityReason } from './loader.ts';
import type { CertificationPhase } from './schema.ts';
import type { ModelRegistry } from '../../model-registry.ts';

export type RouterStage = 'planner' | 'coder' | 'reviewer';

/**
 * Required certification phase for each router stage.
 *
 * Phase ordering: read-only < patch < workflow.
 * A higher certification satisfies all lower required phases.
 */
export const STAGE_REQUIRED_PHASE: Record<RouterStage, CertificationPhase> = {
  planner: 'read-only',
  reviewer: 'read-only',
  coder: 'patch',
};

/**
 * Structured diagnostic for a native model certification rejection.
 *
 * Contains enough information to identify the model, the required phase, the
 * observed failure cause, and a human-readable message for logging.
 */
export interface NativeCertificationDiagnostic {
  modelId: string;
  stage: RouterStage;
  capability: string;
  requiredCertification: CertificationPhase;
  observedCertificationStatus: IneligibilityReason | 'missing-config';
  message: string;
}

export type NativePhaseFilterResult =
  | { allowed: true }
  | { allowed: false; diagnostic: NativeCertificationDiagnostic };

/**
 * Check whether a model passes the certification gate for a given router stage.
 *
 * Returns `allowed: true` for non-native models (no certification gate applies).
 * Returns `allowed: false` with a structured diagnostic for native models that
 * fail the gate.
 *
 * Fail-closed: missing, malformed, stale, wrong-suite, phase-insufficient, and
 * scenario-failure results all cause rejection. A model with `nativeCapability`
 * in the registry but no `certificationSuiteVersion` is rejected immediately
 * (treated as missing configuration).
 */
export function checkNativeCertificationForStage(params: {
  modelId: string;
  stage: RouterStage;
  registry: ModelRegistry;
  repoDir: string | undefined;
  now?: Date;
}): NativePhaseFilterResult {
  const { modelId, stage, registry, repoDir, now } = params;
  const nativeCapability = registry.models[modelId]?.nativeCapability;

  // Not a native model — pass through unconditionally.
  if (!nativeCapability) {
    return { allowed: true };
  }

  const requiredCertification = STAGE_REQUIRED_PHASE[stage];
  const provider = nativeCapability.nativeProvider;
  const certificationSuiteVersion = nativeCapability.certification?.certificationSuiteVersion;

  // No suite version in registry → fail closed (no artifact to check).
  if (!certificationSuiteVersion) {
    return {
      allowed: false,
      diagnostic: {
        modelId,
        stage,
        capability: nativeCapability.readOnlyNative,
        requiredCertification,
        observedCertificationStatus: 'missing-config',
        message:
          `Native model ${modelId} has no certification suite version configured in registry; ` +
          `required ${requiredCertification} certification for ${stage} stage`,
      },
    };
  }

  const eligibility = checkCertificationEligibility(
    repoDir ?? '',
    provider,
    modelId,
    certificationSuiteVersion,
    requiredCertification,
    now,
  );

  if (eligibility.eligible) {
    return { allowed: true };
  }

  return {
    allowed: false,
    diagnostic: {
      modelId,
      stage,
      capability: nativeCapability.readOnlyNative,
      requiredCertification,
      observedCertificationStatus: eligibility.reason,
      message: buildRejectionMessage(modelId, stage, requiredCertification, eligibility.reason),
    },
  };
}

function buildRejectionMessage(
  modelId: string,
  stage: RouterStage,
  requiredCertification: CertificationPhase,
  reason: IneligibilityReason,
): string {
  const base = `Native model ${modelId} rejected for ${stage} stage`;
  switch (reason) {
    case 'missing':
      return `${base}: no certification artifact found (required: ${requiredCertification})`;
    case 'malformed':
      return `${base}: certification artifact is malformed (required: ${requiredCertification})`;
    case 'wrong-version':
      return `${base}: certification suite version mismatch (required: ${requiredCertification})`;
    case 'stale':
      return `${base}: certification has expired (required: ${requiredCertification})`;
    case 'phase-insufficient':
      return `${base}: certification phase insufficient for required ${requiredCertification}`;
    case 'scenario-failure':
      return `${base}: certification has failed scenarios (required: ${requiredCertification})`;
    default:
      return `${base}: ${reason as string} (required: ${requiredCertification})`;
  }
}

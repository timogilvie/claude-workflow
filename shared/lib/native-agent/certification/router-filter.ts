/**
 * Native certification filter for workflow router candidate pools.
 *
 * Applies per-role phase requirements to native model candidates before
 * final pool selection. Non-native models pass through unchanged.
 *
 * Phase requirements by router role:
 * - planner: read-only investigation and plan output → requires at least `read-only` cert
 * - reviewer: read-only operations → requires at least `read-only` cert
 * - coder: patch operations → requires at least `patch` cert
 *
 * All native models without a valid, fresh, phase-satisfying artifact are
 * rejected fail-closed. Non-native models are never affected.
 *
 * @module native-agent/certification/router-filter
 */

import { checkCertificationEligibility, type IneligibilityReason } from './loader.ts';
import type { CertificationPhase } from './schema.ts';
import type { ModelRegistry } from '../../model-registry.ts';

/** Router role names as used in workflow-router.ts */
export type RouterRole = 'planner' | 'coder' | 'reviewer';

/**
 * Required certification phase for each router role.
 *
 * planner → read-only: planner investigates and emits a plan artifact; Wavemill writes artifacts.
 * reviewer → read-only: reviewer reads diffs and outputs comments only.
 * coder → patch: coder produces patch-level file edits.
 */
export const STAGE_PHASE_REQUIREMENT: Record<RouterRole, CertificationPhase> = {
  planner: 'read-only',
  reviewer: 'read-only',
  coder: 'patch',
};

/**
 * Normalized router-facing certification rejection reasons.
 *
 * - `missing`           — artifact file is absent or unreadable
 * - `malformed`         — artifact cannot be parsed or fails schema validation
 * - `wrong-suite`       — schemaVersion or suiteVersion mismatch
 * - `stale`             — TTL or explicit expiresAt exceeded
 * - `insufficient-phase`— certified phase does not satisfy the required phase,
 *                         or a required scenario failed
 */
export type RouterCertificationRejectionReason =
  | 'missing'
  | 'malformed'
  | 'wrong-suite'
  | 'stale'
  | 'insufficient-phase';

/**
 * Diagnostic record for a native model rejected during router pool filtering.
 *
 * Structured so test assertions can verify: model, role, phase, capability,
 * required suite version, and the exact rejection reason.
 */
export interface RouterCertificationRejection {
  /** Model identifier that was rejected */
  modelId: string;
  /** Router role this filter was applied for */
  role: RouterRole;
  /** Certification phase required by this role */
  requestedPhase: CertificationPhase;
  /** Phase found in the artifact, if it was readable */
  certifiedPhase?: CertificationPhase;
  /** `readOnlyNative` value from the model registry */
  nativeCapability: string;
  /** Suite version used for the artifact lookup */
  requiredSuiteVersion: string;
  /** Normalized rejection reason */
  reason: RouterCertificationRejectionReason;
}

function mapIneligibilityReason(reason: IneligibilityReason): RouterCertificationRejectionReason {
  switch (reason) {
    case 'missing': return 'missing';
    case 'malformed': return 'malformed';
    case 'wrong-version': return 'wrong-suite';
    case 'stale': return 'stale';
    case 'phase-insufficient': return 'insufficient-phase';
    case 'scenario-failure': return 'insufficient-phase';
  }
}

/**
 * Filter native model candidates for a given router role.
 *
 * For each model in `models`:
 * - If the model has no `nativeCapability` in the registry: pass through (non-native).
 * - If the model has `nativeCapability` but no registry certification metadata or
 *   no `nativeProvider`: reject as `missing` fail-closed.
 * - Otherwise: load the on-disk certification artifact and evaluate it against
 *   the required phase. Accept if eligible; reject with structured diagnostics if not.
 *
 * @param models - Candidate model IDs to filter
 * @param role - Router role determining the required certification phase
 * @param registry - Model registry for native capability metadata
 * @param repoDir - Repository root for loading on-disk certification artifacts
 * @param now - Optional override for deterministic TTL evaluation in tests
 */
export function filterNativeModels(
  models: string[],
  role: RouterRole,
  registry: ModelRegistry,
  repoDir: string,
  now?: Date,
): { eligible: string[]; rejected: RouterCertificationRejection[] } {
  const requiredPhase = STAGE_PHASE_REQUIREMENT[role];
  const eligible: string[] = [];
  const rejected: RouterCertificationRejection[] = [];

  for (const modelId of models) {
    const nativeCapability = registry.models[modelId]?.nativeCapability;

    // Non-native model — pass through unchanged
    if (!nativeCapability) {
      eligible.push(modelId);
      continue;
    }

    const readOnlyNative = nativeCapability.readOnlyNative;
    const certMeta = nativeCapability.certification;

    // Missing registry metadata or provider — fail closed as `missing`
    if (!certMeta || !nativeCapability.nativeProvider) {
      rejected.push({
        modelId,
        role,
        requestedPhase: requiredPhase,
        nativeCapability: readOnlyNative,
        requiredSuiteVersion: certMeta?.certificationSuiteVersion ?? '',
        reason: 'missing',
      });
      continue;
    }

    const eligibility = checkCertificationEligibility(
      repoDir,
      nativeCapability.nativeProvider,
      modelId,
      certMeta.certificationSuiteVersion,
      requiredPhase,
      now,
    );

    if (eligibility.eligible) {
      eligible.push(modelId);
    } else {
      rejected.push({
        modelId,
        role,
        requestedPhase: requiredPhase,
        certifiedPhase: eligibility.artifact?.phase,
        nativeCapability: readOnlyNative,
        requiredSuiteVersion: certMeta.certificationSuiteVersion,
        reason: mapIneligibilityReason(eligibility.reason),
      });
    }
  }

  return { eligible, rejected };
}

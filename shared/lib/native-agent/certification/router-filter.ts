/**
 * Native certification filter for workflow router candidate pools.
 *
 * Applies per-role phase requirements to native model candidates before
 * final pool selection. Non-native models pass through unchanged.
 *
 * Phase requirements by router role:
 * - reviewer: read-only operations → requires at least `read-only` cert
 * - coder: patch operations → requires at least `patch` cert
 * - planner: workflow orchestration → requires at least `workflow` cert
 *
 * All native models without a valid, fresh, phase-satisfying artifact are
 * rejected fail-closed. Non-native models are never affected.
 *
 * @module native-agent/certification/router-filter
 */

import type { CertificationPhase } from './schema.ts';
import type { NativeAgentAllowedPhase } from '../../config.ts';
import type { ModelRegistry, NativeProviderName } from '../../model-registry.ts';
import type { RoleEligibility } from '../../openrouter-catalog.ts';
import { projectRouterCandidates } from '../../effective-models.ts';

/** Router role names as used in workflow-router.ts */
export type RouterRole = 'planner' | 'coder' | 'reviewer';

/**
 * Required certification phase for each router role.
 *
 * reviewer → read-only: reviewer reads diffs and outputs comments only.
 * coder → patch: coder produces patch-level file edits.
 * planner → workflow: planner orchestrates the full multi-phase workflow.
 */
export const STAGE_PHASE_REQUIREMENT: Record<RouterRole, CertificationPhase> = {
  reviewer: 'read-only',
  coder: 'patch',
  planner: 'workflow',
};

export const ROUTER_ROLE_LAUNCH_PHASE: Record<RouterRole, RoleEligibility> = {
  reviewer: 'review',
  coder: 'coding',
  planner: 'planning',
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
 * - `role-ineligible`   — launch-priority metadata excludes this router role
 * - `phase-not-allowed` — nativeAgent.allowedPhases excludes this launch phase
 */
export type RouterCertificationRejectionReason =
  | 'no-native-capability'
  | 'missing'
  | 'malformed'
  | 'wrong-suite'
  | 'stale'
  | 'insufficient-phase'
  | 'role-ineligible'
  | 'phase-not-allowed';

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
  /** Launch phase corresponding to the router role */
  requestedLaunchPhase: RoleEligibility;
  /** Certification phase required by this role */
  requestedPhase: CertificationPhase;
  /** Phase found in the artifact, if it was readable */
  certifiedPhase?: CertificationPhase;
  /** `readOnlyNative` value from the model registry */
  nativeCapability: string;
  /** Native provider from the model registry, when known */
  nativeProvider?: NativeProviderName;
  /** Launch-priority roles for this model, when the model is known there */
  eligibleRoles?: readonly RoleEligibility[];
  /** Configured nativeAgent phases, when that config gate rejected the model */
  allowedNativeAgentPhases?: readonly NativeAgentAllowedPhase[];
  /** Suite version used for the artifact lookup */
  requiredSuiteVersion: string;
  /** Normalized rejection reason */
  reason: RouterCertificationRejectionReason;
  /** Actual artifact path used for the lookup, when available */
  artifactPath?: string;
  /** Certification artifact scope. Normal runtime selection is global-only. */
  artifactScope?: 'global' | 'legacy-repo';
}

/**
 * Filter native model candidates for a given router role.
 *
 * For each model in `models`:
 * - If the model has no `nativeCapability` in the registry: pass through for
 *   hosted models, but reject legacy OpenRouter/deepseek launcher entries.
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
  const result = projectRouterCandidates({ models, role, registry, repoDir, now });
  return { eligible: result.eligible, rejected: result.rejected };
}

/**
 * Workflow mutation policy matrix (HOK-2355).
 *
 * Encodes which (phase, tool, action) combinations are permitted.
 * The gate is pure: no filesystem, network, clock, env, or process access.
 *
 * Hard invariants encoded in the matrix:
 * - 'merge' is denied in every phase for every tool.
 *   No merge action exists as an allowed path. The entry appears in the enum
 *   solely so the policy can produce a meaningful denial reason.
 * - Review phase can create/update PR artifacts and add labels, but cannot merge.
 * - Ready phase mutation is limited to stale_base and merge_conflict remediation
 *   plus write_stage_result recording. write_stage_result in ready phase is
 *   classified as recording (Wavemill-owned artifact), not external provider mutation.
 * - Unknown (phase, tool, action) triples are denied by default.
 *
 * Ready-stage vocabulary note: 'stale_base' maps to what the ready-stage subsystem
 * calls 'stale-base' or 'auto-update' (PR behind base requiring rebase/merge).
 * See .wavemill/context/ready-stage.md for the full classification vocabulary.
 */

import type { WorkflowPhase, WorkflowToolName, WorkflowMutationAction } from './contracts.ts';

export type { WorkflowPhase, WorkflowToolName, WorkflowMutationAction };

// ---------------------------------------------------------------------------
// Policy result
// ---------------------------------------------------------------------------

export interface MutationPolicyAllowedResult {
  allowed: true;
  /** Stable reason string — tests may assert the full value. */
  reason: string;
}

export interface MutationPolicyDeniedResult {
  allowed: false;
  /** Stable machine-readable denial code derived from the reason prefix. */
  code: string;
  /** Stable reason string — tests may assert the full value. */
  reason: string;
}

export type MutationPolicyResult = MutationPolicyAllowedResult | MutationPolicyDeniedResult;

// ---------------------------------------------------------------------------
// Matrix entry
// ---------------------------------------------------------------------------

interface PolicyEntry {
  phase: WorkflowPhase;
  tool: WorkflowToolName;
  action: WorkflowMutationAction;
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Policy matrix
// ---------------------------------------------------------------------------

/**
 * Explicit allow/deny entries for known (phase, tool, action) combinations.
 * Entries listed here override the default-deny fallback.
 */
const POLICY_MATRIX: readonly PolicyEntry[] = [
  // ---- planning phase -------------------------------------------------------
  // Read-only tools allowed in planning
  { phase: 'planning', tool: 'linear_get_issue', action: 'read',              allowed: true,  reason: 'linear_get_issue is read-only and allowed in planning' },
  { phase: 'planning', tool: 'route_task',        action: 'read',              allowed: true,  reason: 'route_task is read-only (routing analysis) and allowed in planning' },
  { phase: 'planning', tool: 'expand_issue',      action: 'read',              allowed: true,  reason: 'expand_issue reads and creates task packets; allowed in planning' },
  // Stage result recording allowed in planning
  { phase: 'planning', tool: 'write_stage_result', action: 'write_stage_result', allowed: true, reason: 'write_stage_result records Wavemill-owned artifacts; allowed in planning' },
  // Commenting allowed in planning (e.g. progress updates)
  { phase: 'planning', tool: 'linear_comment',   action: 'comment',           allowed: true,  reason: 'linear_comment allowed in planning for progress updates' },

  // ---- coding phase ---------------------------------------------------------
  { phase: 'coding',   tool: 'linear_get_issue', action: 'read',              allowed: true,  reason: 'linear_get_issue is read-only and allowed in coding' },
  { phase: 'coding',   tool: 'linear_comment',   action: 'comment',           allowed: true,  reason: 'linear_comment allowed in coding for progress updates' },
  { phase: 'coding',   tool: 'write_stage_result', action: 'write_stage_result', allowed: true, reason: 'write_stage_result records Wavemill-owned artifacts; allowed in coding' },

  // ---- review phase ---------------------------------------------------------
  // Read tools allowed
  { phase: 'review',   tool: 'linear_get_issue', action: 'read',              allowed: true,  reason: 'linear_get_issue is read-only and allowed in review' },
  { phase: 'review',   tool: 'review_changes',   action: 'read',              allowed: true,  reason: 'review_changes reads diff output; allowed in review' },
  // PR artifact creation and update allowed in review
  { phase: 'review',   tool: 'github_create_pr', action: 'create_pr',         allowed: true,  reason: 'github_create_pr allowed in review; creates PR artifact but does not merge' },
  { phase: 'review',   tool: 'github_create_pr', action: 'update_pr',         allowed: true,  reason: 'github_create_pr may update existing PR artifact in review' },
  // Label allowed in review
  { phase: 'review',   tool: 'github_add_label', action: 'add_label',         allowed: true,  reason: 'github_add_label allowed in review; does not merge' },
  // Comment allowed in review
  { phase: 'review',   tool: 'linear_comment',   action: 'comment',           allowed: true,  reason: 'linear_comment allowed in review for review outcome updates' },
  // Stage result recording
  { phase: 'review',   tool: 'write_stage_result', action: 'write_stage_result', allowed: true, reason: 'write_stage_result records Wavemill-owned artifacts; allowed in review' },
  // Note: 'merge' action denial is handled by the hard invariant in isMutationAllowed.
  // Per-tool merge entries are intentionally omitted from the matrix to avoid dead/divergent code.

  // ---- ready phase ----------------------------------------------------------
  // Ready phase: only stale_base and merge_conflict remediation plus stage result recording.
  // All other mutations are denied.
  { phase: 'ready',    tool: 'linear_get_issue', action: 'read',              allowed: true,  reason: 'linear_get_issue is read-only and allowed in ready' },
  // stale_base remediation — maps to ready-stage "stale-base" / "auto-update" condition
  { phase: 'ready',    tool: 'github_create_pr', action: 'stale_base',        allowed: true,  reason: 'stale_base remediation allowed in ready phase (PR behind base branch)' },
  // merge_conflict remediation
  { phase: 'ready',    tool: 'github_create_pr', action: 'merge_conflict',    allowed: true,  reason: 'merge_conflict remediation allowed in ready phase' },
  // Stage result recording in ready (classified as recording, not external provider mutation)
  { phase: 'ready',    tool: 'write_stage_result', action: 'write_stage_result', allowed: true, reason: 'write_stage_result records Wavemill-owned artifacts; allowed in ready' },
  // Denied in ready: comment, create_pr, update_pr, add_label
  // ('merge' action denial is handled by the hard invariant in isMutationAllowed.)
  { phase: 'ready',    tool: 'linear_comment',   action: 'comment',           allowed: false, reason: 'ready_mutation_denied: unrelated comment not allowed in ready phase' },
  { phase: 'ready',    tool: 'github_create_pr', action: 'create_pr',         allowed: false, reason: 'ready_mutation_denied: general PR creation not allowed in ready phase; only stale_base or merge_conflict remediation' },
  { phase: 'ready',    tool: 'github_create_pr', action: 'update_pr',         allowed: false, reason: 'ready_mutation_denied: general PR update not allowed in ready phase; only stale_base or merge_conflict remediation' },
  { phase: 'ready',    tool: 'github_add_label', action: 'add_label',         allowed: false, reason: 'ready_mutation_denied: label add not allowed in ready phase' },
  { phase: 'ready',    tool: 'expand_issue',     action: 'read',              allowed: false, reason: 'ready_mutation_denied: expand_issue not allowed in ready phase' },
  { phase: 'ready',    tool: 'route_task',        action: 'read',              allowed: false, reason: 'ready_mutation_denied: route_task not allowed in ready phase' },
];

// Pre-index for O(1) lookup
const policyIndex = new Map<string, PolicyEntry>();
for (const entry of POLICY_MATRIX) {
  policyIndex.set(matrixKey(entry.phase, entry.tool, entry.action), entry);
}

function matrixKey(phase: string, tool: string, action: string): string {
  return `${phase}::${tool}::${action}`;
}

function deniedResult(reason: string): MutationPolicyDeniedResult {
  const separatorIndex = reason.indexOf(':');
  const code = separatorIndex === -1 ? 'policy_denied' : reason.slice(0, separatorIndex);
  return { allowed: false, code, reason };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a (phase, tool, action) combination is permitted.
 *
 * Returns `{ allowed: true }` for explicitly allowed entries.
 * Returns `{ allowed: false, reason }` for:
 *   - explicitly denied entries (stable reason strings from the matrix)
 *   - unknown combinations (default-deny with 'unknown_combination' reason)
 *
 * 'merge' action is always denied regardless of phase or tool.
 */
export function isMutationAllowed(
  phase: WorkflowPhase,
  tool: WorkflowToolName,
  action: WorkflowMutationAction,
): MutationPolicyResult {
  // Hard invariant: merge is never allowed, regardless of matrix entry.
  if (action === 'merge') {
    return deniedResult('review_cannot_merge: merge is never an allowed workflow tool action');
  }

  const entry = policyIndex.get(matrixKey(phase, tool, action));
  if (entry !== undefined) {
    return entry.allowed ? { allowed: true, reason: entry.reason } : deniedResult(entry.reason);
  }

  // Default deny for unknown combinations.
  return deniedResult(
    `unknown_combination: no policy entry for phase=${phase} tool=${tool} action=${action}`,
  );
}

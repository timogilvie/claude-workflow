/**
 * Ready-phase per-edit-path guardrail (HOK-2361).
 *
 * Complements the per-(phase, tool, action) mutation-policy matrix by adding a
 * per-edit-path check scoped to the active ready-stage classification (stale_base
 * or merge_conflict). Only edits whose paths fall within the classification's
 * affected-file set are permitted; all others are rejected with structured diagnostics.
 *
 * Design invariants:
 * - Deny-by-default: unknown classification → empty scope → all edits rejected.
 * - Empty-edit-set → allowed (no edits cannot violate scope).
 * - All paths are POSIX-normalized before comparison; traversal paths are rejected.
 * - Pure evaluator: no filesystem, network, clock, env, or process access.
 */

import path from 'node:path';
import type { MergeConflictResult } from '../../ready-stage.ts';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Ready-stage classification kind relevant to remediation scope.
 * - 'stale_base': PR is behind the base branch (maps to ready-watchdog 'auto-update').
 * - 'merge_conflict': PR has merge conflicts (maps to ready-stage CONFLICTED state).
 * - 'unknown': Classification could not be determined; scope is empty (deny-all).
 */
export type ReadyRemediationClassificationKind =
  | 'stale_base'
  | 'merge_conflict'
  | 'unknown';

/**
 * Classification of the ready-stage condition that triggered remediation.
 */
export interface ReadyRemediationClassification {
  kind: ReadyRemediationClassificationKind;
  /**
   * Paths (POSIX, repo-relative) the classification reports as in-scope.
   * For merge_conflict: the conflicted files reported by the ready stage.
   * For stale_base: files whose state must change (e.g. migration files from
   *   checkMigrationBaseFreshness), or empty when remediation is a pure rebase.
   * For unknown: always empty.
   */
  affectedFiles: string[];
  /** Free-form label describing the classification source. */
  source?: string;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Per-edit-path remediation decision produced by evaluateReadyRemediation.
 */
export interface ReadyRemediationDecision {
  decision: 'allowed' | 'denied';
  classification: ReadyRemediationClassificationKind;
  /** Normalized, sorted, deduplicated allowed-scope paths. */
  allowedScope: string[];
  /** Normalized, sorted paths from proposedEdits that were rejected. */
  rejectedEdits: string[];
  /** Human-readable rationale; names rejected paths when decision is 'denied'. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface EvaluateReadyRemediationInput {
  classification: ReadyRemediationClassification;
  /** Repo-relative paths proposed by the remediation agent. */
  proposedEdits: string[];
}

// ---------------------------------------------------------------------------
// Path normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a single path to POSIX form and validate it is safe (no traversal,
 * not absolute). Returns null when the path is unsafe.
 */
function normalizePath(rawPath: string): string | null {
  const normalized = path.posix.normalize(rawPath);
  if (path.posix.isAbsolute(normalized)) {
    return null;
  }
  // Reject paths that escape the repo root via traversal
  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

/** Normalize an array of paths, discarding unsafe entries. */
function normalizePaths(rawPaths: string[]): string[] {
  const result: string[] = [];
  for (const raw of rawPaths) {
    const norm = normalizePath(raw);
    if (norm !== null) {
      result.push(norm);
    }
  }
  return result;
}

/** Sorted, deduped array of paths. */
function sortedDeduped(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

// ---------------------------------------------------------------------------
// Scope derivation
// ---------------------------------------------------------------------------

/**
 * Derive the allowed remediation scope from a classification.
 *
 * - merge_conflict / stale_base: scope = normalized affectedFiles (deduped, sorted).
 * - unknown: scope = [] (deny-all).
 */
export function computeRemediationScope(
  classification: ReadyRemediationClassification,
): string[] {
  if (classification.kind === 'unknown') {
    return [];
  }
  return sortedDeduped(normalizePaths(classification.affectedFiles));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a proposed edit set against the remediation scope derived from the
 * current ready-stage classification.
 *
 * Returns an allowed decision when:
 * - proposedEdits is empty (no-op; cannot violate scope), or
 * - every normalized proposed path is within the allowed scope.
 *
 * Returns a denied decision when:
 * - the classification is unknown (empty scope), or
 * - any proposed path is outside the scope (including unsafe paths).
 */
export function evaluateReadyRemediation(
  input: EvaluateReadyRemediationInput,
): ReadyRemediationDecision {
  const { classification, proposedEdits } = input;
  const allowedScope = computeRemediationScope(classification);
  const allowedSet = new Set(allowedScope);

  if (proposedEdits.length === 0) {
    return {
      decision: 'allowed',
      classification: classification.kind,
      allowedScope,
      rejectedEdits: [],
      rationale: 'no edits proposed',
    };
  }

  const rejectedEdits: string[] = [];

  for (const raw of proposedEdits) {
    const normalized = normalizePath(raw);
    if (normalized === null) {
      // Unsafe path (traversal or absolute) — always rejected
      rejectedEdits.push(raw);
      continue;
    }
    if (!allowedSet.has(normalized)) {
      rejectedEdits.push(normalized);
    }
  }

  if (rejectedEdits.length === 0) {
    const kindLabel = classification.kind === 'stale_base' ? 'stale-base' : 'merge-conflict';
    return {
      decision: 'allowed',
      classification: classification.kind,
      allowedScope,
      rejectedEdits: [],
      rationale: `all proposed edits are within the ${kindLabel} remediation scope`,
    };
  }

  const sortedRejected = [...rejectedEdits].sort();
  const isUnknown = classification.kind === 'unknown';
  const rationale = isUnknown
    ? `ready_remediation_denied: classification is unknown; no edits are permitted. Rejected: ${sortedRejected.join(', ')}`
    : `ready_remediation_denied: proposed edits are outside the ${classification.kind} remediation scope. Rejected: ${sortedRejected.join(', ')}`;

  return {
    decision: 'denied',
    classification: classification.kind,
    allowedScope,
    rejectedEdits: sortedRejected,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

/**
 * Build a ReadyRemediationClassification from a MergeConflictResult and the
 * list of conflicted files reported by the ready stage.
 */
export function fromMergeConflictResult(
  result: MergeConflictResult,
  conflictedFiles: string[],
): ReadyRemediationClassification {
  if (result.status !== 'CONFLICTED') {
    return {
      kind: 'unknown',
      affectedFiles: [],
      source: `merge-conflict-result:${result.status}`,
    };
  }
  return {
    kind: 'merge_conflict',
    affectedFiles: conflictedFiles,
    source: 'merge-conflict-result:CONFLICTED',
  };
}

/**
 * Build a ReadyRemediationClassification for a stale-base condition.
 *
 * @param affectedFiles - Files that need to change to resolve the stale base
 *   (e.g. migration files from checkMigrationBaseFreshness). Pass [] when the
 *   remediation is a pure rebase with no per-file allowlist.
 * @param source - Optional label for the classification source.
 */
export function fromStaleBaseCheck(
  affectedFiles: string[],
  source?: string,
): ReadyRemediationClassification {
  return {
    kind: 'stale_base',
    affectedFiles,
    source: source ?? 'stale-base-check',
  };
}

/**
 * Arbiter S2 survival label contract (HOK-2803).
 *
 * Frozen on-the-wire shape of the survival label the wavemill labeller emits
 * and the Hokusai data pipeline trains on. One label per merged PR per elapsed
 * horizon (14/30/60 days), aggregated over normalized PR line ranges walked on
 * the integration branch — never `main` blame in squash-promotion repos.
 *
 * Sources of truth:
 * - Semantics: `docs/arbiter/survival-label-contract.md` (human-readable freeze)
 * - Validation: `shared/schemas/arbiter-survival-label.schema.json`
 * - Reconciliation lineage: `docs/arbiter/survival-label-reconciliation.md`
 *   (adopts `docs/hokusai-second-model-data-plan.md` §3.1 at PR granularity)
 *
 * Any change to this module or the schema requires a bump of
 * {@link ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION}, coordinated with the
 * `Hokusai/hokusai-data-pipeline` consumer. The contract test
 * (`shared/lib/arbiter-survival-label.test.ts`) fails when producer types,
 * schema, or consumer expectations drift.
 *
 * This module is contract-only: the labeller that computes these values is
 * S2b/S3 work and does not live here.
 */

import { createHash } from 'node:crypto';

/** Contract version. Bump for ANY field/semantics change, however small. */
export const ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION = '1.0.0';

/**
 * Versioned threshold for `report_outcome = 'substantially_rewritten'`:
 * a non-reverted label whose `survival_ratio` is strictly below this value.
 * The threshold is part of the normalization version contract — changing it
 * requires bumping the labeller's `normalization_version`.
 */
export const SUBSTANTIAL_REWRITE_THRESHOLD = 0.5;

/** Elapsed forward windows (days after merge) a label can be computed at. */
export const HORIZONS = [14, 30, 60] as const;
export type HorizonDays = (typeof HORIZONS)[number];

/**
 * `harvested` — produced automatically by the labeller.
 * `owner_corrected` — Tier-2b human correction; weighted heavier downstream
 * (the weight ratio is pinned in the pipeline, not in this contract).
 */
export type LabelProvenance = 'harvested' | 'owner_corrected';

/**
 * Attributable dominant undoer of the labelled ranges. `null` for no undo,
 * formatter-only churn, ambiguous/mixed attribution, or missing labels.
 * Preserves the §3.1 enum: human undo weighted heavily, agent self-undo lightly.
 */
export type UndoneBy = 'human' | 'agent' | null;

/**
 * Deterministic, mutually exclusive derived outcome for reporting/training.
 * `null` means missing/ineligible — never imputed to a terminal value.
 */
export type ReportOutcome =
  | 'survived'
  | 'followup'
  | 'substantially_rewritten'
  | 'reverted'
  | null;

/** Typed reason codes — no free-form reason strings on the wire. */
export const REASON_CODES = [
  // positive-signal codes
  'exact_revert',
  'line_range_followup',
  'linked_issue_or_pr',
  'pre_merge_human_edit',
  'task_redispatch',
  'substantial_rewrite',
  // negative-signal / non-event
  'no_evidence',
  // missing / ineligible causes
  'unmerged_pr',
  'missing_horizon',
  'insufficient_history',
  'insufficient_line_range_substrate',
  'inaccessible_history',
  'ambiguous_change',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * The subset of {@link REASON_CODES} valid for a missing label
 * (`report_outcome === null`). A missing label carries exactly one of these.
 */
export const MISSING_REASON_CODES = [
  'unmerged_pr',
  'missing_horizon',
  'insufficient_history',
  'insufficient_line_range_substrate',
  'inaccessible_history',
  'ambiguous_change',
] as const satisfies readonly ReasonCode[];
export type MissingReasonCode = (typeof MISSING_REASON_CODES)[number];

/** SHA-anchored 1-based inclusive line coordinates in one commit's tree. */
export interface LineRangeAnchor {
  start: number;
  end: number;
  /** Full git object id (40 hex for SHA-1 repos, 64 for SHA-256 repos). */
  sha: string;
}

/**
 * One normalized PR-changed range. `old` anchors pre-change coordinates at the
 * labelled PR's base for the file; `new` anchors post-change coordinates at
 * `pr_head_sha`. `old` is null for pure additions, `new` is null for pure
 * deletions; never both null.
 */
export interface LineRange {
  path: string;
  old: LineRangeAnchor | null;
  new: LineRangeAnchor | null;
}

/**
 * Outcome fields. All-null (with one missing reason code) means the label is
 * missing/ineligible; missing labels are emitted explicitly, never imputed.
 */
export interface SurvivalOutcome {
  survived: boolean | null;
  /** Line-weighted fraction 0.0–1.0 of normalized PR lines present at the horizon terminal tree. */
  survival_ratio: number | null;
  /** Exact/high-precision restoration of pre-change lines over the PR ranges only. */
  reverted: boolean | null;
  undone_by: UndoneBy;
  followup: boolean | null;
  report_outcome: ReportOutcome;
  /** Non-empty. Missing labels: exactly one {@link MissingReasonCode}. */
  reason_codes: ReasonCode[];
}

/**
 * Everything a downstream re-runner needs to reproduce the label: exact code
 * versions and exact git inputs. All SHAs are on `integration_branch`.
 */
export interface ReproducibilityEnvelope {
  /** Equals {@link ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION} at emit time (and the top-level schema_version). */
  schema_version: string;
  labeller_version: string;
  /** Version of the normalizer + threshold table (includes {@link SUBSTANTIAL_REWRITE_THRESHOLD}). */
  normalization_version: string;
  pr_head_sha: string;
  /** Integration-branch merge commit for this PR — never a `main` squash commit. */
  merge_sha: string;
  /** Tip of integration_branch at (merge_sha committer time + horizon_days). */
  horizon_terminal_sha: string;
  /** Branch walked by the labeller, e.g. `auto/integration`. `main` rejected in v1.0.0. */
  integration_branch: string;
  /** ISO-8601 UTC. Latest computed_at per (prUrl, horizon_days) wins in queries. */
  computed_at: string;
}

/**
 * Tier-2b owner correction. The harvested row is never mutated in place —
 * the correction is an additional row linked to its predecessor by hash.
 */
export interface OwnerCorrection {
  supersedes: {
    schema_version: string;
    computed_at: string;
    /** {@link canonicalHash} of the superseded label (harvested or a prior correction). */
    label_hash: string;
  };
  correction: {
    reason_code: ReasonCode | 'owner_dispute';
    /** Opaque identity of the human owner. */
    corrected_by: string;
    corrected_at: string;
    /** So the pipeline can compute the delta for an already-trained-on row. */
    previous_report_outcome: ReportOutcome;
    note?: string;
  };
}

/** The full v1.0.0 label object. One per (prUrl, horizon_days) per provenance event. */
export interface ArbiterSurvivalLabelV1 {
  schema_version: '1.0.0';
  prUrl: string;
  horizon_days: HorizonDays;
  label_provenance: LabelProvenance;
  line_ranges: LineRange[];
  outcome: SurvivalOutcome;
  envelope: ReproducibilityEnvelope;
  /** Required iff label_provenance === 'owner_corrected'; forbidden otherwise. */
  owner_correction?: OwnerCorrection;
}

/** Inputs to {@link deriveReportOutcome} — the four computed outcome components. */
export interface ReportOutcomeInputs {
  survived: boolean | null;
  survival_ratio: number | null;
  reverted: boolean | null;
  followup: boolean | null;
}

/**
 * Derive the mutually exclusive `report_outcome` from computed components.
 *
 * Precedence (first match wins):
 * 1. `null` — any component is null (missing/ineligible; never imputed).
 * 2. `reverted` — exact revert beats everything, including co-occurring followup.
 * 3. `substantially_rewritten` — survival_ratio < threshold.
 * 4. `followup`.
 * 5. `survived`.
 *
 * @param threshold Versioned substantial-rewrite threshold; defaults to
 *   {@link SUBSTANTIAL_REWRITE_THRESHOLD}. Pass the value pinned by the
 *   emitting labeller's `normalization_version` when replaying old labels.
 */
export function deriveReportOutcome(
  inputs: ReportOutcomeInputs,
  threshold: number = SUBSTANTIAL_REWRITE_THRESHOLD,
): ReportOutcome {
  const { survived, survival_ratio, reverted, followup } = inputs;
  if (survived === null || survival_ratio === null || reverted === null || followup === null) {
    return null;
  }
  if (reverted) return 'reverted';
  if (survival_ratio < threshold) return 'substantially_rewritten';
  if (followup) return 'followup';
  return 'survived';
}

/**
 * Recursively sort object keys so canonical serialization is independent of
 * insertion order. Arrays keep element order (order is meaningful for
 * line_ranges and reason_codes).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical-JSON serialization of a label: keys sorted recursively at every
 * depth, no insignificant whitespace. This is the byte string
 * {@link canonicalHash} digests; both sides of the contract must use it when
 * computing or verifying `owner_correction.supersedes.label_hash`.
 */
export function canonicalSerialize(label: ArbiterSurvivalLabelV1): string {
  return JSON.stringify(canonicalize(label));
}

/**
 * SHA-256 (lowercase hex) of {@link canonicalSerialize}. Identity of a label
 * row for Tier-2b supersession: an owner correction points at the exact bytes
 * that may already have been trained on, so the pipeline can find and
 * invalidate or downweight that row.
 */
export function canonicalHash(label: ArbiterSurvivalLabelV1): string {
  return createHash('sha256').update(canonicalSerialize(label), 'utf-8').digest('hex');
}

/** Inputs the builder needs; `report_outcome` and versions are derived/stamped. */
export interface BuildSurvivalLabelInput {
  prUrl: string;
  horizon_days: HorizonDays;
  label_provenance: LabelProvenance;
  line_ranges: LineRange[];
  outcome: Omit<SurvivalOutcome, 'report_outcome'>;
  envelope: Omit<ReproducibilityEnvelope, 'schema_version'>;
  owner_correction?: OwnerCorrection;
  /** Override only when replaying with a historical normalization threshold. */
  substantialRewriteThreshold?: number;
}

/**
 * Assemble a v1.0.0 label: stamps `schema_version` (top-level and envelope)
 * and derives `report_outcome` via {@link deriveReportOutcome}. Pure and
 * deterministic; performs no git or network work. Schema validation stays the
 * caller's job (compile `shared/schemas/arbiter-survival-label.schema.json`).
 */
export function buildArbiterSurvivalLabel(input: BuildSurvivalLabelInput): ArbiterSurvivalLabelV1 {
  const report_outcome = deriveReportOutcome(
    {
      survived: input.outcome.survived,
      survival_ratio: input.outcome.survival_ratio,
      reverted: input.outcome.reverted,
      followup: input.outcome.followup,
    },
    input.substantialRewriteThreshold,
  );
  const label: ArbiterSurvivalLabelV1 = {
    schema_version: '1.0.0',
    prUrl: input.prUrl,
    horizon_days: input.horizon_days,
    label_provenance: input.label_provenance,
    line_ranges: input.line_ranges,
    outcome: { ...input.outcome, report_outcome },
    envelope: {
      ...input.envelope,
      schema_version: ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION,
    },
  };
  if (input.owner_correction !== undefined) {
    label.owner_correction = input.owner_correction;
  }
  return label;
}

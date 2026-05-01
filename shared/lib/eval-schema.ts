/**
 * Eval scoring rubric and data schema for the wavemill eval system.
 *
 * Defines a 0–1 scoring rubric that maps autonomous task outcomes to
 * human-readable bands, plus the {@link EvalRecord} type that captures
 * a complete eval result.
 *
 * ## Schema Changelog
 *
 * - **1.0.0**: Initial schema with core eval fields
 * - **1.1.0**: Added `pricingSnapshot` field (HOK-858) to capture pricing
 *   table snapshot at time of evaluation, enabling cost normalization when
 *   pricing changes over time
 * - **1.2.0**: Added `promptArtifacts` field (HOK-1003) to track prompt
 *   template versions and hashes for GEPA training signal attribution
 * - **1.3.0**: Added `stageOutcomes` field (HOK-1004) to capture per-stage
 *   quality attribution scores (expansion, plan, implementation, review) and
 *   routing outcome metadata for GEPA training
 * - **1.4.0**: Added `taskDescriptor` field (HOK-1120) to capture generalizable
 *   task features for router training, including heuristic signals, learned
 *   signals, constraints, per-stage model assignments, and outcomes
 * - **1.5.0**: `timeSeconds` now records actual wall-clock duration computed
 *   from task-branch git history instead of always remaining `0` (HOK-1329)
 * - **1.6.0**: Added optional `fallbackEvent` metadata for cross-model quota
 *   fallback attribution (HOK-1336)
 * - **1.7.0**: Added optional `budgetViolated` and `budgetViolationDetails`
 *   fields to track cost budget constraint violations during routing (HOK-1350)
 * - **1.8.0**: Added optional `manifestRef` for per-run resource manifest
 *   attribution (HOK-1378)
 * - **1.9.0**: Added optional `planCritique` to capture explicit planning
 *   quality dimensions from the eval judge (HOK-1391)
 * - **1.10.0**: Added optional `resourceSelections` for governed runtime
 *   prompt/router artifact attribution (HOK-1380), and `rubricEval` field
 *   (HOK-1406) to capture per-criterion rubric scores as durable training
 *   signal; includes rubric version for forward compatibility and
 *   determinative boundary classification
 * - **1.11.0**: Added optional `rubricCriteria` array to `StageScore`
 *   (HOK-1407) to persist per-stage structured criteria from the eval judge;
 *   enables higher-fidelity GEPA attribution and per-criterion failure analysis
 * - **1.12.0**: Added optional `rubric_provenance` field (HOK-1408) to mark
 *   whether rubric data came directly from the judge, was backfilled, or is
 *   explicitly absent on legacy records
 * - **1.13.0**: Added optional `rubric` section to `TaskDescriptor`
 *   (HOK-1409) to propagate rubric-derived features (criterion count, mean
 *   score, per-criterion scores, determinative boundary) into privacy-safe
 *   descriptor data for router training
 * - **1.14.0**: Added optional `provider` and `endpoint` metadata for
 *   Claude-compatible provider attribution (HOK-1485), plus optional
 *   eligibility diagnostics fields to `EvalRecord` (HOK-1492) so training
 *   and budget-export consumers can inspect stable ineligibility reasons
 *   without silently dropping rows
 * - **1.15.0**: Added optional Wavemill router benchmark output fields to
 *   `EvalRecord` (HOK-1507), including
 *   `workflow_success_rate_under_budget`, structured router diagnostics, and
 *   scorer/policy attribution metadata
 *
 * @module eval-schema
 */

import type { ModelPricing } from './workflow-cost.ts';
import type { RegistryTaskType } from './model-registry.ts';
import type { RuntimeResourceSelection } from './resource-selection.ts';

// ────────────────────────────────────────────────────────────────
// Scoring Rubric
// ────────────────────────────────────────────────────────────────

/**
 * A single band in the scoring rubric.
 *
 * Each band covers a contiguous range of the 0–1 score space.
 * `min` is inclusive and `max` is inclusive.
 */
export interface ScoreBand {
  /** Human-readable label for this band (e.g. "Full Success") */
  readonly label: string;
  /** Lower bound of the band (inclusive) */
  readonly min: number;
  /** Upper bound of the band (inclusive) */
  readonly max: number;
  /** Plain-language description of what qualifies for this band */
  readonly description: string;
}

/**
 * The five scoring bands that partition the 0.0–1.0 range.
 *
 * | Band              | Range     | Meaning |
 * |-------------------|-----------|---------|
 * | Failure           | 0.0–0.1   | Task not completed; fundamental misunderstanding or no meaningful output |
 * | Partial           | 0.2–0.4   | Some progress but major gaps remain; output is not usable without significant rework |
 * | Assisted Success  | 0.5–0.7   | Task completed with notable human intervention; core goal achieved but required guidance |
 * | Minor Feedback    | 0.8–0.9   | Task completed with minor corrections; output was nearly autonomous |
 * | Full Success      | 1.0       | Task completed autonomously with no human intervention; output is production-ready |
 */
export const SCORE_BANDS = [
  {
    label: 'Failure',
    min: 0.0,
    max: 0.1,
    description:
      'Task not completed; fundamental misunderstanding or no meaningful output.',
  },
  {
    label: 'Partial',
    min: 0.2,
    max: 0.4,
    description:
      'Some progress but major gaps remain; output is not usable without significant rework.',
  },
  {
    label: 'Assisted Success',
    min: 0.5,
    max: 0.7,
    description:
      'Task completed with notable human intervention; core goal achieved but required guidance.',
  },
  {
    label: 'Minor Feedback',
    min: 0.8,
    max: 0.9,
    description:
      'Task completed with minor corrections; output was nearly autonomous.',
  },
  {
    label: 'Full Success',
    min: 1.0,
    max: 1.0,
    description:
      'Task completed autonomously with no human intervention; output is production-ready.',
  },
] as const satisfies readonly ScoreBand[];

/** Union of all valid score band labels */
export type ScoreBandLabel = (typeof SCORE_BANDS)[number]['label'];

/**
 * Map a numeric score (0–1) to its rubric band.
 *
 * Scores that fall between defined bands are rounded to the nearest band.
 * Scores outside 0–1 throw a RangeError.
 *
 * @param score - A number between 0 and 1 (inclusive)
 * @returns The matching {@link ScoreBand}
 * @throws {RangeError} If score is outside the 0–1 range
 *
 * @example
 * ```ts
 * getScoreBand(1.0).label  // "Full Success"
 * getScoreBand(0.6).label  // "Assisted Success"
 * getScoreBand(0.0).label  // "Failure"
 * ```
 */
export function getScoreBand(score: number): ScoreBand {
  if (score < 0 || score > 1) {
    throw new RangeError(`Score must be between 0 and 1, got ${score}`);
  }

  // Walk bands in order; return the first band whose range contains the score.
  // Because bands have gaps (e.g. 0.1–0.2), scores in gaps are assigned to
  // the nearest band by checking which band boundary is closer.
  for (const band of SCORE_BANDS) {
    if (score >= band.min && score <= band.max) {
      return band;
    }
  }

  // Score falls in a gap between bands — find the closest band.
  let closest: ScoreBand = SCORE_BANDS[0];
  let minDistance = Infinity;
  for (const band of SCORE_BANDS) {
    const distance = Math.min(
      Math.abs(score - band.min),
      Math.abs(score - band.max),
    );
    if (distance < minDistance) {
      minDistance = distance;
      closest = band;
    }
  }
  return closest;
}

// ────────────────────────────────────────────────────────────────
// Token Usage
// ────────────────────────────────────────────────────────────────

/**
 * Token usage from an LLM API call.
 */
export interface TokenUsage {
  /** Number of input (prompt) tokens */
  inputTokens: number;
  /** Number of output (completion) tokens */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
}

// ────────────────────────────────────────────────────────────────
// Intervention Record
// ────────────────────────────────────────────────────────────────

/**
 * Intervention type enum — describes the reason for human intervention.
 */
export type InterventionType =
  | 'clarification'
  | 'bugfix'
  | 'manual_merge'
  | 'environment_fix'
  | 'prompt_edit'
  | 'scope_change'
  | 'rollback';

/**
 * Intervention severity enum — indicates impact level.
 */
export type InterventionSeverity = 'low' | 'med' | 'high';

/**
 * Stable eligibility error codes for downstream training and budget export.
 *
 * @since 1.14.0
 */
export type EligibilityErrorCode =
  | 'missing_routing'
  | 'missing_cost'
  | 'missing_budget_snapshot'
  | 'missing_outcome'
  | 'missing_task_descriptor'
  | 'missing_model_identity';

/**
 * A single structured intervention event.
 *
 * Captures when, why, and how a human intervened during task execution.
 * Enables ML routing to learn which task characteristics lead to babysitting.
 */
export interface InterventionRecord {
  /** ISO 8601 datetime when the intervention occurred */
  timestamp: string;

  /** Type of intervention (reason) */
  type: InterventionType;

  /** Severity/impact of the intervention */
  severity: InterventionSeverity;

  /** Human-readable description of what was done */
  note: string;

  /** Optional time spent on this intervention in seconds */
  timeSpentSeconds?: number;
}

// ────────────────────────────────────────────────────────────────
// Routing Decision (HOK-775)
// ────────────────────────────────────────────────────────────────

/**
 * A single candidate configuration considered during routing.
 *
 * Captures the full specification of a model + agent + toolset combination
 * that was eligible for selection by the router.
 */
export interface RoutingCandidate {
  /** Agent type (e.g., "claude", "codex") */
  agentType: string;

  /** Model identifier (e.g., "claude-opus-4-6", "gpt-5.3-codex") */
  modelId: string;

  /** Specific model version string (optional) */
  modelVersion?: string;

  /** Toolset variant identifier (optional) */
  toolsetId?: string;

  /** Price tier classification (e.g., "low", "medium", "high") */
  priceTier?: string;
}

/**
 * Routing decision metadata capturing all candidates considered.
 *
 * Records the full decision context: which models were eligible,
 * which was chosen, and why. Essential for training routing models
 * to learn cost/quality tradeoffs.
 *
 * **Why this matters:** Without the candidate set, a router can't learn
 * "use cheaper model when similar quality" because it never sees what
 * "similar" meant relative to the alternatives.
 */
export interface RoutingDecision {
  /**
   * All candidate configurations that were eligible for this task.
   *
   * Should include at least 2 candidates (otherwise no decision was made).
   */
  candidates: RoutingCandidate[];

  /**
   * The chosen candidate.
   *
   * Can be either:
   * - A full RoutingCandidate object (reference)
   * - A number (index into the candidates array)
   */
  chosen: RoutingCandidate | number;

  /**
   * Decision policy version that made this choice.
   *
   * Examples: "baseline", "router-v1.0", "router-v2.1-prod"
   */
  decisionPolicyVersion: string;

  /**
   * Optional rationale or top features used for the decision.
   *
   * Can be free text or structured (e.g., JSON of feature weights).
   */
  decisionRationale?: string;

  /** Runtime-governed resource selections used while making the routing decision. */
  resourceSelections?: RuntimeResourceSelection[];
}

export interface ManifestRef {
  sessionId: string;
  manifestDigest: string;
  path?: string;
}

// ────────────────────────────────────────────────────────────────
// Task Context (HOK-774)
// ────────────────────────────────────────────────────────────────

/**
 * Task type classification for routing and evaluation.
 */
export type TaskType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'chore'
  | 'docs'
  | 'test'
  | 'infra';

/**
 * Change kind classification for understanding task scope.
 */
export type ChangeKind = 'modify_existing' | 'create_new' | 'mixed';

/**
 * Complexity band classification for task difficulty.
 */
export type ComplexityBand = 'xs' | 's' | 'm' | 'l' | 'xl';

/**
 * Task constraints that affect how the task can be executed.
 */
export interface TaskConstraints {
  /** Whether the task requires strict adherence to a style guide */
  hasStrictStyle?: boolean;

  /** Whether the task has modules/files that must not be touched */
  mustNotTouchX?: boolean;

  /** Whether the task is timeboxed with a deadline */
  timeboxed?: boolean;

  /** Whether the task must be completed without network access */
  noNetAccess?: boolean;
}

/**
 * Task context metadata for routing and evaluation.
 *
 * Describes the nature of the task to enable better model selection,
 * routing decisions, and stratified evaluation.
 */
export interface TaskContext {
  /** Type of task being performed */
  taskType: TaskType;

  /** Whether the task modifies existing code, creates new code, or both */
  changeKind: ChangeKind;

  /** Complexity score (0-1) or band classification */
  complexity: number | ComplexityBand;

  /** Special constraints that apply to this task */
  constraints?: TaskConstraints;

  /** Estimated number of files to be touched */
  filesTouchedEstimate?: number;

  /** Estimated lines of code to be changed */
  expectedLoCChange?: number;

  /** Domain-specific knowledge required (e.g., "payments", "auth", "k8s") */
  requiresDomainKnowledge?: string | boolean;
}

// ────────────────────────────────────────────────────────────────
// Repo Context (HOK-774)
// ────────────────────────────────────────────────────────────────

/**
 * Repository visibility classification.
 */
export type RepoVisibility = 'oss' | 'private';

/**
 * Repository size metrics.
 */
export interface RepoSize {
  /** Total number of files in the repository */
  fileCount: number;

  /** Total lines of code in the repository */
  loc: number;

  /** Number of dependencies (approximate) */
  dependencyCount: number;
}

/**
 * Repository context metadata for routing and evaluation.
 *
 * Describes the repository characteristics to enable better model selection,
 * routing decisions, and stratified evaluation.
 */
export interface RepoContext {
  /** Stable identifier for the repository (hash or slug) */
  repoId: string;

  /** Whether the repository is open source or private */
  repoVisibility: RepoVisibility;

  /** Primary programming language */
  primaryLanguage: string;

  /** Map of language to percentage (e.g., {"TypeScript": 75, "JavaScript": 25}) */
  languages?: Record<string, number>;

  /** Frameworks used in the repository */
  frameworks?: string[];

  /** Build system (e.g., "webpack", "vite", "gradle") */
  buildSystem?: string;

  /** Package manager (e.g., "npm", "yarn", "pnpm") */
  packageManager?: string;

  /** Test frameworks (e.g., ["jest", "vitest"]) */
  testFrameworks?: string[];

  /** CI provider (e.g., "github-actions", "gitlab-ci") */
  ciProvider?: string;

  /** Repository size metrics */
  repoSize?: RepoSize;

  /** Whether the repository is a monorepo */
  monorepo?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Outcome Decomposition (HOK-776)
// ────────────────────────────────────────────────────────────────

/**
 * Status of a single CI check run.
 */
export interface CiCheck {
  /** Check name (e.g. "tests", "lint", "build") */
  name: string;
  /** Check status */
  status: 'success' | 'failure' | 'pending' | 'skipped' | 'cancelled';
  /** Check duration in seconds (if available) */
  durationSeconds?: number;
}

/**
 * CI/CD outcome: whether checks ran and their results.
 */
export interface CiOutcome {
  /** Whether CI checks were triggered for this PR */
  ran: boolean;
  /** Whether all CI checks passed */
  passed: boolean;
  /** Individual check results */
  checks: CiCheck[];
}

/**
 * Test outcome: test additions and results.
 */
export interface TestsOutcome {
  /** Whether new test files were added in this PR */
  added: boolean;
  /** Test pass rate (0-1), if test results are available */
  passRate?: number;
  /** Total test execution time in seconds, if available */
  durationSeconds?: number;
}

/**
 * Static analysis outcome: lint, typecheck, and security findings.
 */
export interface StaticAnalysisOutcome {
  /** Change in lint errors (negative = improvement, positive = regression) */
  lintDelta?: number;
  /** Whether typecheck passed */
  typecheckPassed?: boolean;
  /** Change in security findings (negative = improvement) */
  securityFindingsDelta?: number;
}

/**
 * Review outcome: human review activity on the PR.
 */
export interface ReviewOutcome {
  /** Whether human review was required (any review comments or changes requested) */
  humanReviewRequired: boolean;
  /** Number of distinct review submission rounds */
  rounds: number;
  /** Number of approval reviews */
  approvals: number;
  /** Number of change request reviews */
  changeRequests: number;
  /** Number of self-review iterations (from review-changes tool) */
  selfReviewIterations?: number;
  /** Number of blocker findings in self-review */
  selfReviewBlockers?: number;
  /** Number of warning findings in self-review */
  selfReviewWarnings?: number;
}

/**
 * Rework outcome: agent iterations and failures during implementation.
 */
export interface ReworkOutcome {
  /** Number of agent iterations (session turns, commits, or retries) */
  agentIterations: number;
  /** Number of tool/API call failures, if tracked */
  toolFailures?: number;
}

/**
 * Delivery outcome: PR creation, merge status, and timing.
 */
export interface DeliveryOutcome {
  /** Whether a PR was created */
  prCreated: boolean;
  /** Whether the PR was merged */
  merged: boolean;
  /** Time from PR creation to merge in seconds, if merged */
  timeToMergeSeconds?: number;
}

/**
 * Decomposed outcome components for granular eval analysis.
 *
 * Stores the raw outcome data that contributes to the overall score.
 * This enables re-scoring with different utility functions and
 * routing based on outcome patterns.
 */
export interface Outcomes {
  /** Hard gate: whether the task succeeded (derived from score) */
  success: boolean;
  /** CI/CD check results */
  ci?: CiOutcome;
  /** Test additions and results */
  tests?: TestsOutcome;
  /** Static analysis results */
  staticAnalysis?: StaticAnalysisOutcome;
  /** Human review activity */
  review: ReviewOutcome;
  /** Agent rework and failures */
  rework: ReworkOutcome;
  /** PR delivery status */
  delivery: DeliveryOutcome;
}

/**
 * Budget constraints applied to the task at routing time.
 *
 * Separate from taskContext.constraints, which describes prompt-level rules
 * such as style, scope, or environment restrictions.
 */
export interface EvalConstraints {
  /** Maximum routing budget in USD for the task. */
  maxCostUsd?: number;
}

// ────────────────────────────────────────────────────────────────
// Difficulty Classification (HOK-777)
// ────────────────────────────────────────────────────────────────

/**
 * Difficulty band classification for task complexity.
 *
 * Derived from quantifiable signals (LOC touched, files modified, etc.)
 * to enable weighted rewards and stratified evaluation.
 */
export type DifficultyBand = 'trivial' | 'easy' | 'medium' | 'hard' | 'very_hard';

/**
 * Quantifiable difficulty signals computed from PR data.
 *
 * These metrics are derived from git diff analysis and provide
 * objective measures of task complexity.
 */
export interface DifficultySignals {
  /** Lines of code touched (additions + deletions) */
  locTouched: number;

  /** Number of files modified in the PR */
  filesTouched: number;

  /** Dependency depth (optional - 0 if not computed) */
  dependencyDepth?: number;

  /** Test runtime in seconds (optional) */
  testRuntime?: number;

  /** Module hotspot score 0-100 (optional - based on git history) */
  moduleHotspotScore?: number;

  /** True when diff parsing returned suspicious results (e.g. 0 LOC with files present) */
  diffUncertain?: boolean;
}

/**
 * Tech stack and size stratum for stratified evaluation.
 *
 * Format: "{tech_stack}_{size_band}"
 * Examples: "ts_nextjs_small", "py_django_med", "go_std_large"
 */
export type Stratum = string;

// ────────────────────────────────────────────────────────────────
// Per-Stage Outcomes (HOK-1004)
// ────────────────────────────────────────────────────────────────

/**
 * A single structured per-stage rubric criterion from the eval judge.
 *
 * @since 1.11.0
 */
export interface RubricCriterion {
  /** Criterion identifier, e.g. "requirement_coverage" */
  criterion: string;
  /** Normalized score 0.0-1.0 for this stage criterion */
  score: number;
  /** Optional brief explanation from the judge */
  notes?: string;
}

/**
 * Per-stage quality attribution from the eval judge.
 *
 * Captures how well a specific workflow stage performed,
 * enabling GEPA to attribute quality loss to specific prompt artifacts.
 */
export interface StageScore {
  /** Quality score 0.0–1.0 for this stage */
  score: number;
  /** 1-2 sentence attribution rationale */
  rationale: string;
  /** Detailed plan critique when available for the plan stage */
  planCritique?: PlanCritique;
  /** Structured criterion-level scores for this stage */
  rubricCriteria?: RubricCriterion[];
}

/**
 * A single plan-critique rubric dimension.
 *
 * Captures both the normalized score and the judge's rationale so plan
 * quality can be compared directly across models.
 */
export interface PlanCritiqueDimension {
  /** Quality score 0.0–1.0 for this planning dimension */
  score: number;
  /** 1-2 sentence rationale for the score */
  rationale: string;
}

/**
 * Explicit critique of plan quality across the key planning dimensions.
 */
export interface PlanCritique {
  /** Whether the plan chose the right component/service boundaries */
  component_boundaries: PlanCritiqueDimension;
  /** Whether the plan surfaced key invariants and constraints */
  invariant_coverage: PlanCritiqueDimension;
  /** Whether the proposed approach was viable and correct */
  approach_soundness: PlanCritiqueDimension;
  /** Whether implementation had to patch around plan gaps */
  missed_patches: PlanCritiqueDimension;
  /** Aggregate plan-quality assessment */
  overall: PlanCritiqueDimension;
}

/**
 * Which scoring boundary was the binding constraint on the final score.
 *
 * Identifies the rule from "Scoring boundaries (strict)" that capped the
 * final score, enabling analysis of which boundary applies most often.
 *
 * @since 1.10.0
 */
export type RubricDeterminativeBoundary =
  | 'no_interventions'
  | 'cosmetic_only'
  | 'functional_bug'
  | 'multiple_bugs'
  | 'heavy_intervention';

/**
 * Score and rationale for a single rubric criterion.
 *
 * @since 1.10.0
 */
export interface RubricCriterionScore {
  /** Normalized score 0.0–1.0 for this criterion */
  score: number;
  /** 1-sentence rationale from the judge */
  rationale: string;
}

/**
 * Per-criterion rubric scores from the eval judge.
 *
 * @since 1.10.0
 */
export interface RubricCriteria {
  /** Were all requirements in the task prompt addressed? */
  completeness: RubricCriterionScore;
  /** Does the implementation work correctly? */
  correctness: RubricCriterionScore;
  /** Clean, idiomatic, follows project conventions? */
  code_quality: RubricCriterionScore;
  /** Combined count + severity penalty (1.0 = no interventions, 0.0 = maximum) */
  intervention_impact: RubricCriterionScore;
  /** Holistic judgment of autonomous execution (1.0 = fully autonomous) */
  autonomy: RubricCriterionScore;
}

/**
 * Structured rubric criteria evaluation from the judge.
 *
 * Captures per-criterion scores as durable training signal and records
 * which scoring boundary was the binding constraint on the final score.
 *
 * @since 1.10.0
 */
export interface RubricEval {
  /** Schema version for this rubricEval shape (currently "1.0") */
  schema_version: '1.0';
  /** Semantic rubric version; bump when criteria/boundaries change meaningfully */
  rubric_version: string;
  /** Per-criterion scores */
  criteria: RubricCriteria;
  /** Which scoring boundary was the binding constraint on the final score */
  determinative_boundary?: RubricDeterminativeBoundary;
}

/**
 * Provenance of rubric metadata attached to an eval record.
 *
 * Distinguishes new records with judge-emitted rubric from historical rows
 * that were explicitly marked during backfill, allowing mixed-quality
 * training datasets to weight or filter records safely.
 *
 * @since 1.12.0
 */
export type RubricProvenance = 'judge' | 'backfill_derived' | 'legacy_absent';

/**
 * Routing outcome — deterministic record, not judge-scored.
 *
 * Records the routing decision and its realized outcome for offline
 * routing model training. The judge cannot assess counterfactual model
 * choices, so this is captured deterministically.
 */
export interface RoutingOutcome {
  /** Whether a routing decision was made (vs default model) */
  routingUsed: boolean;
  /** Number of candidates considered */
  candidateCount: number;
  /** Model that was chosen */
  chosenModel?: string;
  /** Score achieved by the workflow */
  scoreAchieved?: number;
  /** Workflow cost in USD */
  costUsd?: number;
  /** Policy version that made the decision */
  policyVersion?: string;
}

/**
 * Per-stage outcome attribution for GEPA training.
 *
 * Each stage gets a quality score that helps identify where in the
 * pipeline quality was lost. For example, if the overall score is 0.7,
 * the stage scores should clarify whether the spec was the problem
 * (low expansion, higher implementation) or the code was the problem
 * (high expansion, low implementation).
 */
export interface StageOutcomes {
  /** Task packet / expansion quality */
  expansion?: StageScore;
  /** Plan quality and adherence */
  plan?: StageScore;
  /** Implementation quality (given spec + plan) */
  implementation?: StageScore;
  /** Self-review effectiveness */
  review?: StageScore;
  /** Routing decision record (deterministic) */
  routing?: RoutingOutcome;
}

// ────────────────────────────────────────────────────────────────
// Task Descriptor (HOK-1120)
// ────────────────────────────────────────────────────────────────

/**
 * Heuristic signals derived from task prompt and PR diff.
 *
 * These are objective, deterministic features that can be computed
 * without LLM calls or domain expertise. All features are privacy-safe
 * (no repo names, issue IDs, or code snippets).
 */
export interface HeuristicSignals {
  /** Type of task being performed */
  task_type: TaskType;
  /** Programming languages used (from file extensions) */
  languages: string[];
  /** Frameworks detected in the codebase */
  framework_tags: string[];
  /** Number of files modified in the PR */
  files_touched: number;
  /** Repository size in lines of code */
  repo_size_loc: number;
  /** Approximate token count of task description */
  description_tokens: number;
  /** Whether the task creates new code (vs modifying existing) */
  is_greenfield: boolean;
  /** Whether the task involves a database migration */
  has_migration: boolean;
  /** Whether the task has UI components */
  has_ui: boolean;
  /** Whether the task adds or modifies tests */
  has_tests: boolean;
  /** Whether the task spans multiple services */
  cross_service: boolean;
}

/**
 * Learned signals that require classification or embedding.
 *
 * These features may be derived from LLM classifiers, embeddings,
 * or trained models. They capture higher-level semantics beyond
 * what heuristics can detect.
 */
export interface LearnedSignals {
  /** Complexity score 1-5 (mapped from xs/s/m/l/xl bands) */
  complexity: number;
  /** Domain classification for the task */
  domain: string;
  /** Risk flags detected in the task */
  risk_flags: string[];
  /** Optional vector store reference for nearest-neighbor lookup */
  embedding_id?: string;
}

/**
 * Constraints and objectives for task execution.
 *
 * Captures resource limits and optimization goals that guide
 * routing decisions.
 */
export interface DescriptorConstraints {
  /** Maximum cost budget in USD */
  max_cost_usd?: number;
  /** Maximum time budget in minutes */
  max_time_minutes?: number;
  /** Models available for routing consideration */
  models_available: string[];
  /** Routing objective (maximize success, minimize cost, or balanced) */
  objective: 'max_success' | 'min_cost' | 'balanced';
}

/**
 * Per-stage execution details for a workflow stage.
 *
 * Records which model was used and the resulting quality, cost, and time.
 * Used for offline routing model training.
 */
export interface StageDescriptor {
  /** Model identifier used for this stage */
  model: string;
  /** Quality score 0-1 for this stage (null pre-eval) */
  score?: number;
  /** Cost in USD for this stage */
  cost_usd?: number;
  /** Time spent on this stage in minutes */
  time_minutes?: number;
}

/**
 * Overall task outcome summary.
 *
 * Aggregates quality, cost, time, and intervention metrics for the
 * complete workflow. Used as training labels for routing models.
 */
export interface DescriptorOutcome {
  /** Overall quality score 0-1 */
  overall_score: number;
  /** Total workflow cost in USD */
  total_cost_usd?: number;
  /** Total workflow time in minutes */
  total_time_minutes?: number;
  /** Number of human interventions required */
  interventions: number;
  /** Types of interventions that occurred */
  intervention_types: string[];
}

/**
 * Task descriptor for router training and prediction.
 *
 * Consolidates all generalizable task features into a single,
 * privacy-safe, router-friendly structure. Contains no repo names,
 * issue IDs, or proprietary code snippets.
 *
 * This descriptor serves dual purposes:
 * 1. Router input (pre-eval): signals + constraints → predict model assignment
 * 2. Training label (post-eval): signals + stages + outcome → learn routing policy
 *
 * @since 1.4.0
 */
export interface TaskDescriptor {
  /** Schema version for forward compatibility */
  schema_version: '1.0';
  /** Heuristic and learned feature signals */
  signals: {
    heuristic: HeuristicSignals;
    learned: LearnedSignals;
  };
  /** Constraints and routing objectives */
  constraints: DescriptorConstraints;
  /** Per-stage model assignments and outcomes */
  stages: Record<string, StageDescriptor>;
  /** Rubric-derived features for router training */
  rubric?: {
    /** Whether rubric criteria were present on this record */
    has_rubric: boolean;
    /** Number of criteria with valid finite scores */
    criterion_count: number;
    /** Mean score across valid criteria */
    mean_score: number;
    /** Per-criterion scores (fixed bounded dimensions) */
    criteria_scores: {
      completeness: number;
      correctness: number;
      code_quality: number;
      intervention_impact: number;
      autonomy: number;
    };
    /** Which rubric boundary determinatively capped the score */
    determinative_boundary?: string;
  };
  /** Overall outcome (null when used as router input pre-eval) */
  outcome?: DescriptorOutcome;
}

// ────────────────────────────────────────────────────────────────
// Fallback Event (HOK-1336)
// ────────────────────────────────────────────────────────────────

/**
 * Outcome taxonomy for cross-model fallback events.
 */
export type FallbackOutcome = 'success' | 'all_exhausted' | 'non_quota_error';

/**
 * Snapshot of a single model's quota health at fallback time.
 */
export interface QuotaSnapshotEntry {
  /** Current quota status for the model. */
  status: 'healthy' | 'degrading' | 'exhausted';
  /** When the model's quota is expected to recover, if known. */
  resetAt: string | null;
  /** Estimated remaining capacity, if available. */
  remainingEstimate: number | null;
  /** Confidence in the current estimate, normalized to 0-1. */
  confidence: number;
}

/**
 * Structured metadata for a quota-driven fallback event.
 *
 * Uses snake_case to match downstream training consumers.
 *
 * @since 1.6.0
 */
export interface FallbackEventMetadata {
  /** Schema version for forward compatibility. */
  schema_version: '1.0';
  /** Model preferred before any fallback occurred. */
  preferred_model: string;
  /** Model that ultimately produced the response, or null if none succeeded. */
  fallback_model: string | null;
  /** Task type used to select the fallback ladder. */
  task_type: RegistryTaskType | null;
  /** Difficulty classification supplied by the caller when known. */
  difficulty?: DifficultyBand | null;
  /** Quota-state snapshot captured near the fallback event. */
  quota_snapshot: {
    snapshotAt: string;
    models: Record<string, QuotaSnapshotEntry>;
  };
  /** Whether a human manually intervened in the fallback path. */
  human_intervention: boolean;
  /** Final outcome of the fallback sequence. */
  outcome: FallbackOutcome;
  /** End-to-end wall-clock duration across the fallback sequence. */
  latency_ms: number;
  /** Observed cost in USD across the fallback sequence, if surfaced. */
  cost_usd: number | null;
  /** Ordered list of models that failed before success or terminal exit. */
  fallback_chain: Array<{ model: string; reason: string }>;
}

// ────────────────────────────────────────────────────────────────
// Wavemill Router Eval (HOK-1507)
// ────────────────────────────────────────────────────────────────

export type WavemillRouterMeasurementPolicy =
  | 'replay_exact_match'
  | 'challenge_prospective';

export interface WavemillRouterDiagnostics {
  scoreable_coverage: number;
  invalid_route_rate: number;
  budget_compliance_rate: number;
  completion_success_rate: number;
  total_cost_usd: number;
  timing_p50_ms: number;
  timing_p95_ms: number;
  intervention_rate: number;
  intervention_count: number;
  total_records: number;
  scoreable_records: number;
  invalid_route_records: number;
}

export interface WavemillRouterScoringMetadata {
  scorer_id: string;
  measurement_policy: WavemillRouterMeasurementPolicy;
}

// ────────────────────────────────────────────────────────────────
// Eval Record
// ────────────────────────────────────────────────────────────────

/**
 * A single eval result record.
 *
 * Captures everything needed to assess, compare, and analyse an
 * autonomous task execution — the prompt, the model, the outcome
 * score, timing, and any human interventions that occurred.
 */
export interface EvalRecord {
  /** Unique identifier for this eval record (UUID v4 recommended) */
  id: string;

  /** Schema version for forward compatibility (semver, e.g. "1.0.0") */
  schemaVersion: string;

  /** The task prompt that was given to the agent */
  originalPrompt: string;

  /** Model identifier (e.g. "claude-opus-4-6") */
  modelId: string;

  /** Specific model version string for reproducibility */
  modelVersion: string;

  /** Model ID used by the LLM judge for this eval */
  judgeModel?: string;

  /** Provider used by the LLM judge for this eval (e.g. "anthropic") */
  judgeProvider?: string;

  /** Execution provider for the evaluated workflow (e.g. "deepseek") */
  provider?: string;

  /** API endpoint used by the evaluated workflow when provider-specific */
  endpoint?: string;

  /** Numeric score between 0 and 1 (inclusive) */
  score: number;

  /** The rubric band label derived from the score */
  scoreBand: ScoreBandLabel;

  /** Wall-clock time in seconds for task completion */
  timeSeconds: number;

  /** ISO 8601 datetime string when the eval was recorded */
  timestamp: string;

  /** Whether any human intervention was required during the task */
  interventionRequired: boolean;

  /** Number of distinct human interventions during the task */
  interventionCount: number;

  /** Brief description of each human intervention (legacy - prefer interventions field) */
  interventionDetails: string[];

  /** Structured intervention events (machine-usable) */
  interventions?: InterventionRecord[];

  /** Free-text rationale from the LLM judge explaining the score */
  rationale: string;

  /** Linear issue identifier (e.g. "HOK-697"), if the task was issue-based */
  issueId?: string;

  /** Shared identifier linking both sides of a challenge-mode pair */
  challengePairId?: string;

  /** Pull request URL, if the task produced a PR */
  prUrl?: string;

  /** Token usage from the LLM judge API call */
  tokenUsage?: TokenUsage;

  /** Estimated cost in USD based on the pricing table */
  estimatedCost?: number;

  /** Agent that produced the work being evaluated (e.g. "claude", "codex") */
  agentType?: string;

  /** Total estimated cost in USD to build the feature (all agent sessions on this branch) */
  workflowCost?: number;

  /** Whether the record includes the fields required for training export. */
  trainingEligible?: boolean;

  /** Whether the record includes the fields required for budget-eval export. */
  budgetEvalEligible?: boolean;

  /** Stable machine-readable reasons why the record is ineligible for exports. */
  eligibilityErrors?: EligibilityErrorCode[];

  /** Per-model token usage breakdown from the workflow sessions */
  workflowTokenUsage?: Record<
    string,
    {
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  >;

  /** Status of workflow cost computation (HOK-883) */
  workflowCostStatus?: 'success' | 'no_sessions' | 'no_branch' | 'adapter_error' | 'missing_worktree' | 'skipped';

  /** Diagnostic details when workflowCost is missing (HOK-883) */
  workflowCostDiagnostics?: {
    reason: string;
    worktreePath?: string;
    branchName?: string;
    agentType?: string;
    sessionFilesFound?: number;
    matchingTurns?: number;
    totalAssistantTurns?: number;
    branchMismatches?: number;
  };

  /** Snapshot of the pricing table used for workflowCost calculation (HOK-858) */
  pricingSnapshot?: Record<string, ModelPricing>;

  /** Difficulty band classification (e.g. "easy", "medium", "hard") */
  difficultyBand?: DifficultyBand;

  /** Quantifiable difficulty metrics from PR analysis */
  difficultySignals?: DifficultySignals;

  /** Tech stack and size stratum (e.g. "ts_nextjs_small", "py_django_med") */
  stratum?: Stratum;

  /** Task context metadata for routing and evaluation (HOK-774) */
  taskContext?: TaskContext;

  /** Repository context metadata for routing and evaluation (HOK-774) */
  repoContext?: RepoContext;

  /** Decomposed outcome components (quality, cost, speed, risk dimensions) */
  outcomes?: Outcomes;

  /** Routing decision metadata (required if training routing models) */
  routingDecision?: RoutingDecision;

  /**
   * Prompt artifacts used during workflow execution.
   *
   * Tracks which prompt template versions were used to enable attribution
   * of performance to specific prompt artifacts. Essential for GEPA
   * (Gradient-based Executable Prompt Adaptation) training.
   *
   * Each artifact captures:
   * - Template name (e.g., "issue-writer", "eval-judge")
   * - Template hash (SHA-256 of template file at time of use)
   * - Filled prompt hash (SHA-256 of filled prompt sent to LLM)
   *
   * @since 1.2.0
   */
  promptArtifacts?: {
    templateName: string;
    templateHash: string;
    filledPromptHash: string;
  }[];

  /** Runtime-governed resource variants used by this run. */
  resourceSelections?: RuntimeResourceSelection[];

  manifestRef?: ManifestRef;

  /**
   * Per-stage quality attribution for GEPA training.
   *
   * Captures quality scores for each workflow stage (expansion, plan,
   * implementation, review) to enable attribution of performance to
   * specific prompt artifacts. This tells GEPA which prompt failed when
   * a workflow scores poorly.
   *
   * @since 1.3.0
   */
  stageOutcomes?: StageOutcomes;

  /**
   * Task descriptor for router training.
   *
   * Consolidates generalizable task features (heuristic signals, learned
   * signals, constraints, per-stage outcomes) into a single privacy-safe
   * structure suitable for training routing models. Contains no repo names,
   * issue IDs, or proprietary code snippets.
   *
   * @since 1.4.0
   */
  taskDescriptor?: TaskDescriptor;

  /**
   * Structured rubric criteria evaluation from the judge.
   *
   * Captures per-criterion scores (completeness, correctness, code quality,
   * intervention impact, autonomy) as durable training signal.
   * Also records which scoring boundary was the binding constraint.
   *
   * @since 1.10.0
   */
  rubricEval?: RubricEval;

  /**
   * Provenance of the rubric metadata attached to this eval record.
   *
   * `judge` means the rubric was emitted directly by the eval judge.
   * `backfill_derived` means a later tool reconstructed rubric semantics.
   * `legacy_absent` means the record predates rubric capture and was
   * explicitly marked as lacking rubric data.
   *
   * @since 1.12.0
   */
  rubric_provenance?: RubricProvenance;

  /**
   * Cross-model fallback telemetry for quota-aware training attribution.
   *
   * @since 1.6.0
   */
  fallbackEvent?: FallbackEventMetadata;

  /**
   * Whether the routing decision violated cost budget constraints.
   *
   * True when the router could not find a model combination within the
   * configured or operating-mode budget, indicating runaway spend risk.
   *
   * @since 1.7.0
   */
  budgetViolated?: boolean;

  /**
   * Structured budget violation details if budgetViolated is true.
   *
   * Captures the cost overage, operating mode, attempted downgrade, and
   * cheapest available option for analysis of budget constraint tuning.
   *
   * @since 1.7.0
   */
  budgetViolationDetails?: {
    /** Estimated cost that exceeded the budget */
    requestedCost: number;
    /** Budget limit that was exceeded */
    maxCostUsd: number;
    /** Operating mode at time of violation (normal, constrained, survival) */
    operatingMode: 'normal' | 'constrained' | 'survival';
    /** Whether the router attempted to downgrade models to fit budget */
    attemptedDowngrade: boolean;
    /** Cheapest available model combination and its cost */
    cheapestOption?: {
      totalCost: number;
      wouldStillExceed: boolean;
    };
  };

  /** Budget constraints applied during routing and execution. */
  constraints?: EvalConstraints;

  /** Wavemill router benchmark score: successful completions that stayed under budget. */
  workflow_success_rate_under_budget?: number;

  /** Wavemill router benchmark diagnostics and coverage metrics. */
  wavemill_router_diagnostics?: WavemillRouterDiagnostics;

  /** Wavemill router scorer metadata for replay/prospective measurement. */
  wavemill_router_scoring?: WavemillRouterScoringMetadata;

  /** Optional extensibility bag for additional metadata */
  metadata?: Record<string, unknown>;
}

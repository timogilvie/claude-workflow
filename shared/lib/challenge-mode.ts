import type { ChallengeRecommendation, ChallengeStage } from './challenge-scheduler.ts';
export type { ChallengeStage } from './challenge-scheduler.ts';
import {
  selectLeastUsedChallenger,
  type ChallengeSelectionReason,
} from './challenge-coverage-selector.ts';
import { loadWavemillConfig, type ChallengeConfig, type RouterConfig } from './config.ts';
import { isDeepSeekModel } from './deepseek-provider.ts';
import { filterDisabledModels, isDisabledModel } from './disabled-models.ts';
import { getEffectiveRegistry, getModel, getSupportedStages } from './model-registry.ts';
import {
  applyConfiguredModelExclusions,
  type ModelExclusionDiagnostic,
} from './model-exclusions.ts';
import { resolveAgent, tryResolveAgent, type AgentResolutionPhase } from './model-router.ts';
import { filterOpenRouterModels } from './openrouter-provider.ts';
import { listVariedRoutingDimensions, routingMetaFromChallengeEntry } from './challenge-comparison.ts';
export { routeChangedMaterially } from './route-artifact.ts';
import { routeChangedMaterially, type RouteArtifactSnapshot } from './route-artifact.ts';
import { routeWorkflow, type WorkflowRouteDecision } from './workflow-router.ts';
import { filterNativeModels, type RouterCertificationRejection, type RouterRole } from './native-agent/certification/router-filter.ts';
import { isPatchCodingEnabled } from './native-agent/coding-gate.ts';

export type ChallengeRole = 'primary' | 'challenger';
export type ChallengeDecisionSource = 'bootstrap' | 'expanded' | 'preserved';

/** Re-export so callers don't need to import from internal certification paths */
export type ChallengeNativeRejection = RouterCertificationRejection;

/** Maps each challenge stage to the equivalent router role for cert phase lookup */
const STAGE_TO_ROLE: Record<ChallengeStage, RouterRole> = {
  plan: 'planner',
  implementation: 'coder',
  review: 'reviewer',
};

export interface ChallengeTaskEntry {
  key: string;
  issueId: string;
  slug: string;
  branch: string;
  role: ChallengeRole;
  model: string;
  agent: string;
  planner: string;
  plannerAgent: string;
  reviewer: string;
  reviewerAgent: string;
  planDepth: string;
  codeDepth: string;
  reviewMode: string;
}

export interface ChallengePairSelection {
  pairId: string;
  primary: ChallengeTaskEntry;
  challenger: ChallengeTaskEntry;
  routeContext?: ChallengeRouteContext;
  selectionReason?: ChallengeSelectionReason;
  challengerCoverageCount?: number;
  /**
   * Which workflow stage the pair varies. Exactly one stage's model differs
   * between primary and challenger; the other two are shared so comparison
   * outcomes attribute cleanly to the varied stage. Absent on legacy pairs
   * (treat as 'implementation').
   */
  challengeStage?: ChallengeStage;
}

export interface ChallengeStageWeights {
  plan?: number;
  implementation?: number;
  review?: number;
}

export interface ChallengeCoverageOptions {
  coverage?: (model: string, stage: ChallengeStage) => number;
  rotationSeed?: string;
  recommendedChallengerModel?: string;
}

const CHALLENGE_STAGES: readonly ChallengeStage[] = ['plan', 'implementation', 'review'];
const NO_VALID_CHALLENGE_DIVERGENCE_REASON = 'no_valid_challenge_divergence';
export type ChallengeSelectionFailureReason = 'selection_failed' | typeof NO_VALID_CHALLENGE_DIVERGENCE_REASON;

export interface ChallengePairSelectionResult<T extends ChallengePairSelection = ChallengePairSelection> {
  pair: T | null;
  failureReason?: ChallengeSelectionFailureReason;
  /** Native models excluded from candidacy due to missing/stale/phase-insufficient cert */
  nativeCertificationRejections?: ChallengeNativeRejection[];
  modelExclusions?: ModelExclusionDiagnostic[];
}

/**
 * Choose which stage a challenge pair should vary.
 *
 * A `low-data-stage` scheduler recommendation wins outright. Otherwise the
 * stage is sampled from `challenge.stageWeights`; with no weights configured
 * the result is always 'implementation', preserving coder-only behavior.
 */
export function chooseChallengeStage(opts: {
  weights?: ChallengeStageWeights;
  recommendedStage?: ChallengeStage;
  randomFn?: () => number;
} = {}): ChallengeStage {
  if (opts.recommendedStage && CHALLENGE_STAGES.includes(opts.recommendedStage)) {
    return opts.recommendedStage;
  }

  const randomFn = opts.randomFn || Math.random;
  const weights = CHALLENGE_STAGES.map((stage) => {
    const value = opts.weights?.[stage];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    return 'implementation';
  }

  let threshold = randomFn() * total;
  for (let index = 0; index < CHALLENGE_STAGES.length; index += 1) {
    threshold -= weights[index];
    if (threshold <= 0) {
      return CHALLENGE_STAGES[index];
    }
  }
  return 'implementation';
}

/**
 * The model occupying the pair's varied stage on the given entry.
 */
export function variedModelForStage(entry: ChallengeTaskEntry, stage: ChallengeStage | undefined): string {
  if (stage === 'plan') return entry.planner || entry.model;
  if (stage === 'review') return entry.reviewer || entry.model;
  return entry.model;
}

export interface ChallengeRouteContext {
  decisionSource: ChallengeDecisionSource;
  bootstrapRoute?: RouteArtifactSnapshot;
  expandedRoute?: RouteArtifactSnapshot;
  refreshRationale?: string;
}

export interface DeepSeekChallengeFilterResult {
  models: string[];
  warnings: string[];
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function filterImplementationLaunchableNativeCandidates(
  pool: string[],
  repoDir: string,
  now?: Date,
): { models: string[]; rejections: ChallengeNativeRejection[] } {
  const registry = getEffectiveRegistry(repoDir);
  const gate = isPatchCodingEnabled(repoDir);
  const models: string[] = [];
  const rejections: ChallengeNativeRejection[] = [];

  for (const modelId of pool) {
    const nativeCapability = registry.models[modelId]?.nativeCapability;
    if (!nativeCapability) {
      models.push(modelId);
      continue;
    }

    if (gate.enabled) {
      models.push(modelId);
      continue;
    }

    rejections.push({
      modelId,
      role: 'coder',
      requestedPhase: 'patch',
      nativeCapability: nativeCapability.readOnlyNative,
      requiredSuiteVersion: nativeCapability.certification?.certificationSuiteVersion ?? '',
      reason: 'no-native-capability',
    });
  }

  return {
    models,
    rejections,
  };
}

/**
 * Filter a model pool for native certification eligibility at the given challenge stage.
 *
 * Non-native models pass through unchanged. When `repoDir` is absent the pool is
 * returned as-is (preserves behavior for callers that have no repo context, e.g. tests
 * that don't set up disk artifacts).
 */
function filterNativeChallengeCandidates(
  pool: string[],
  stage: ChallengeStage,
  repoDir?: string,
  now?: Date,
): { models: string[]; rejections: ChallengeNativeRejection[] } {
  if (!repoDir) {
    return { models: pool, rejections: [] };
  }
  const registry = getEffectiveRegistry(repoDir);
  const role = STAGE_TO_ROLE[stage];
  const { eligible, rejected } = filterNativeModels(uniqueNonEmpty(pool), role, registry, repoDir, now);
  return { models: eligible, rejections: rejected };
}

function filterEligibleChallengeCandidates(
  pool: string[],
  stage: ChallengeStage,
  repoDir?: string,
  now?: Date,
): { models: string[]; rejections: ChallengeNativeRejection[] } {
  const role = STAGE_TO_ROLE[stage];
  const stageCompatible = repoDir
    ? uniqueNonEmpty(pool).filter((modelId) => getSupportedStages(modelId, getEffectiveRegistry(repoDir)).includes(role))
    : uniqueNonEmpty(pool);
  const excluded = applyConfiguredModelExclusions(stageCompatible, role, repoDir);
  const { models: nativeEligible, rejections } = filterNativeChallengeCandidates(excluded.models, stage, repoDir, now);
  const implementationLaunchable = repoDir && stage === 'implementation'
    ? filterImplementationLaunchableNativeCandidates(nativeEligible, repoDir, now)
    : { models: nativeEligible, rejections: [] };
  const openRouterEligible = repoDir
    ? filterOpenRouterModels(implementationLaunchable.models, repoDir, STAGE_TO_ROLE[stage]).models
    : implementationLaunchable.models;
  return {
    models: filterDisabledModels(uniqueNonEmpty(openRouterEligible)),
    rejections: [...rejections, ...implementationLaunchable.rejections],
  };
}

function mergeRejections<T extends ChallengePairSelection>(
  result: ChallengePairSelectionResult<T>,
  additionalRejections: ChallengeNativeRejection[],
): ChallengePairSelectionResult<T> {
  const combined: ChallengeNativeRejection[] = [];
  const seen = new Set<string>();
  for (const rejection of [
    ...additionalRejections,
    ...(result.nativeCertificationRejections || []),
  ]) {
    const key = `${rejection.modelId}\u0000${rejection.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(rejection);
  }
  if (combined.length === 0) return result;
  return { ...result, nativeCertificationRejections: combined };
}

function selectCertifiedImplementationPrimary(
  pool: string[],
  primaryModel: string | undefined,
  opts: {
    repoDir?: string;
    now?: Date;
    randomFn: () => number;
  },
): { model?: string; rejections: ChallengeNativeRejection[]; failureReason?: ChallengeSelectionFailureReason } {
  const { models: certifiedPool, rejections } =
    filterEligibleChallengeCandidates(pool, 'implementation', opts.repoDir, opts.now);
  const uniquePool = filterDisabledModels(uniqueNonEmpty(certifiedPool));
  const allRejections: ChallengeNativeRejection[] = [...rejections];

  let selected = primaryModel?.trim() || '';
  if (isDisabledModel(selected)) {
    selected = '';
  }

  if (selected && opts.repoDir) {
    const { models, rejections: primaryRejections } =
      filterEligibleChallengeCandidates([selected], 'implementation', opts.repoDir, opts.now);
    if (primaryRejections.length > 0) {
      allRejections.push(...primaryRejections);
    }
    if (models.length === 0) {
      selected = '';
    }
  }

  if (!selected) {
    if (uniquePool.length === 0) {
      return { rejections: allRejections, failureReason: 'selection_failed' };
    }
    const primaryIndex = Math.floor(opts.randomFn() * uniquePool.length);
    selected = uniquePool[primaryIndex] || '';
  }

  if (!selected) {
    return { rejections: allRejections, failureReason: 'selection_failed' };
  }

  return { model: selected, rejections: allRejections };
}

export function filterDeepSeekChallengeModels(
  pool: string[],
  challengeConfig?: ChallengeConfig,
): DeepSeekChallengeFilterResult {
  const uniquePool = uniqueNonEmpty(pool);
  if (challengeConfig?.allowDeepseek === true) {
    return { models: uniquePool, warnings: [] };
  }

  const filtered = uniquePool.filter((model) => !isDeepSeekModel(model) && model !== 'claude-deepseek');
  return {
    models: filtered,
    warnings: filtered.length === uniquePool.length
      ? []
      : ['DeepSeek excluded: challenge.allowDeepseek is not enabled'],
  };
}

export function getChallengeModelPoolFromConfig(repoDir?: string): string[] {
  const config = loadWavemillConfig(repoDir);
  return getChallengeModelPool(config.challenge, config.router, repoDir);
}

export function getChallengeModelPool(
  challengeConfig?: ChallengeConfig,
  routerConfig?: RouterConfig,
  repoDir?: string,
): string[] {
  const configured = challengeConfig?.models;
  // Disabled models must never enter the challenge pool, even when listed
  // explicitly in challenge.models — the disable set is authoritative.
  const source = Array.isArray(configured)
    ? configured
    : routerConfig?.models && routerConfig.models.length > 0
      ? routerConfig.models
      : repoDir
        ? Object.keys(getEffectiveRegistry(repoDir).models)
        : [];
  return filterDisabledModels(filterDeepSeekChallengeModels(source, challengeConfig).models);
}

export function canRunChallenge(pool: string[]): boolean {
  return uniqueNonEmpty(pool).length >= 2;
}

export function deriveChallengerKey(issueId: string): string {
  return `${issueId}_c`;
}

export function deriveChallengeSlug(baseSlug: string, role: ChallengeRole): string {
  return role === 'challenger' ? `${baseSlug}-challenger` : baseSlug;
}

export function deriveChallengeBranch(baseSlug: string, role: ChallengeRole): string {
  return `task/${deriveChallengeSlug(baseSlug, role)}`;
}

export function chooseDistinctChallengerModel(
  pool: string[],
  primaryModel: string,
  randomFn: () => number = Math.random,
): string | null {
  const candidates = filterDisabledModels(uniqueNonEmpty(pool)).filter((model) => model !== primaryModel);
  if (candidates.length === 0) {
    return null;
  }

  const index = Math.floor(randomFn() * candidates.length);
  return candidates[index] || null;
}

interface ChallengerSelectionResult {
  model: string | null;
  selectionReason?: ChallengeSelectionReason;
  coverageCount?: number;
}

interface ChallengerSelectionOptions extends ChallengeCoverageOptions {
  stage?: ChallengeStage;
}

function withSelectionMetadata(
  pair: ChallengePairSelection,
  selection: ChallengerSelectionResult,
): ChallengePairSelection {
  if (!selection.selectionReason && typeof selection.coverageCount !== 'number') {
    return pair;
  }
  return {
    ...pair,
    ...(selection.selectionReason ? { selectionReason: selection.selectionReason } : {}),
    ...(typeof selection.coverageCount === 'number'
      ? { challengerCoverageCount: selection.coverageCount }
      : {}),
  };
}

function resolveChallengerModel(
  pool: string[],
  primaryModel: string,
  forced: string | undefined,
  randomFn: () => number,
  selectionOpts?: ChallengerSelectionOptions,
): ChallengerSelectionResult {
  const enabledPool = filterDisabledModels(uniqueNonEmpty(pool));
  const trimmed = forced?.trim();
  if (selectionOpts?.coverage && selectionOpts.stage) {
    const selection = selectLeastUsedChallenger({
      stage: selectionOpts.stage,
      primaryModel,
      candidates: enabledPool,
      coverage: selectionOpts.coverage,
      recommendedChallenger: selectionOpts.recommendedChallengerModel?.trim() || trimmed || undefined,
      rotationSeed: selectionOpts.rotationSeed || `${selectionOpts.stage}|${primaryModel}`,
    });
    if (!selection.model || selection.selectionReason === 'no-eligible-candidate') {
      return { model: null };
    }
    return {
      model: selection.model,
      selectionReason: selection.selectionReason,
      coverageCount: selection.coverageCount,
    };
  }
  if (trimmed && trimmed !== primaryModel && !isDisabledModel(trimmed) && enabledPool.includes(trimmed)) {
    return { model: trimmed };
  }
  return { model: chooseDistinctChallengerModel(enabledPool, primaryModel, randomFn) };
}

function chooseDistinctStageModel(
  pool: string[],
  primaryModel: string,
  forced: string | undefined,
  randomFn: () => number,
  selectionOpts?: ChallengerSelectionOptions,
): ChallengerSelectionResult {
  const uniquePool = filterDisabledModels(uniqueNonEmpty(pool));
  if (selectionOpts?.coverage && selectionOpts.stage) {
    return resolveChallengerModel(uniquePool, primaryModel, forced, randomFn, selectionOpts);
  }
  const trimmedForced = forced?.trim();
  if (trimmedForced && trimmedForced !== primaryModel && !isDisabledModel(trimmedForced) && uniquePool.includes(trimmedForced)) {
    return { model: trimmedForced };
  }

  const candidates = uniquePool.filter((model) => model !== primaryModel);
  if (candidates.length === 0) {
    return { model: null };
  }

  if (trimmedForced && trimmedForced === primaryModel) {
    return { model: candidates[0] || null };
  }

  return resolveChallengerModel(uniquePool, primaryModel, undefined, randomFn);
}

export type ChallengeSelectionPath = 'recommendation-driven' | 'random-roll';

export interface ChallengeLaunchDecision {
  launch: boolean;
  selectionPath: ChallengeSelectionPath;
  forcedChallengerModel?: string;
  recommendation?: ChallengeRecommendation;
}

const RECOMMENDATION_REASONS = ['low-confidence', 'new-model', 'low-data-stage'] as const;

/**
 * Read the routing decision's scheduler recommendation from persisted route
 * artifacts (expanded preferred over bootstrap). Returns null when neither
 * artifact carries an actionable recommendation.
 */
export function extractChallengeRecommendation(artifacts: {
  bootstrap: RouteArtifactSnapshot | null;
  expanded: RouteArtifactSnapshot | null;
}): ChallengeRecommendation | null {
  for (const snapshot of [artifacts.expanded, artifacts.bootstrap]) {
    const raw = snapshot?.expectedMetrics?.challengeRecommendation;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }

    const recommendation = raw as Partial<ChallengeRecommendation>;
    if (
      recommendation.shouldChallenge === true
      && RECOMMENDATION_REASONS.includes(recommendation.reason as typeof RECOMMENDATION_REASONS[number])
    ) {
      return recommendation as ChallengeRecommendation;
    }
  }
  return null;
}

/**
 * Decide whether a mill task should launch in challenge mode.
 *
 * Exploration-driven recommendations (`new-model`, `low-data-stage`) fire at
 * `recommendationRate` (default 1.0 — always, when slots allow) and force the
 * scheduler's least-tested challenger when it is in the pool. A
 * `low-confidence` recommendation keeps the configured random rate but still
 * prefers the recommended challenger. Without a recommendation this is the
 * plain random roll.
 */
export function decideChallengeLaunch(opts: {
  pool: string[];
  primaryModel?: string;
  rate: number;
  recommendationRate?: number;
  recommendation?: ChallengeRecommendation | null;
  randomFn?: () => number;
}): ChallengeLaunchDecision {
  const randomFn = opts.randomFn || Math.random;
  const recommendation = opts.recommendation || undefined;

  if (!recommendation) {
    return {
      launch: randomFn() < opts.rate,
      selectionPath: 'random-roll',
    };
  }

  const exploration = recommendation.reason === 'new-model' || recommendation.reason === 'low-data-stage';
  const effectiveRate = exploration ? (opts.recommendationRate ?? 1) : opts.rate;
  const challenger = recommendation.challengerModel?.trim();
  const challengerUsable = Boolean(
    challenger
    && !isDisabledModel(challenger)
    && filterDisabledModels(uniqueNonEmpty(opts.pool)).includes(challenger as string)
    && challenger !== (opts.primaryModel?.trim() || ''),
  );

  return {
    launch: randomFn() < effectiveRate,
    selectionPath: 'recommendation-driven',
    ...(challengerUsable ? { forcedChallengerModel: challenger } : {}),
    recommendation,
  };
}

export function pickChallengeModels(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
  },
): ChallengePairSelection | null {
  return pickChallengeModelsWithReason(pool, opts).pair;
}

export function pickChallengeModelsWithReason(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    now?: Date;
  } & ChallengeCoverageOptions,
): ChallengePairSelectionResult {
  const { models: certifiedPool, rejections: poolRejections } =
    filterEligibleChallengeCandidates(pool, 'implementation', opts.repoDir, opts.now);
  const uniquePool = filterDisabledModels(uniqueNonEmpty(certifiedPool));
  const allRejections: ChallengeNativeRejection[] = [...poolRejections];
  const randomFn = opts.randomFn || Math.random;
  const defaultAgent = opts.defaultAgent || 'claude';
  const agentMap = opts.agentMap || {};

  let primaryModel = opts.primaryModel?.trim() || '';
  if (isDisabledModel(primaryModel)) {
    primaryModel = '';
  }

  // Reject an externally-supplied primary that is an uncertified native
  if (primaryModel && opts.repoDir) {
    const { models, rejections } = filterEligibleChallengeCandidates([primaryModel], 'implementation', opts.repoDir, opts.now);
    if (rejections.length > 0) {
      allRejections.push(...rejections);
    }
    if (models.length === 0) {
      primaryModel = '';
    }
  }

  if (!primaryModel) {
    if (!canRunChallenge(uniquePool)) {
      return mergeRejections({ pair: null, failureReason: 'selection_failed' }, allRejections);
    }
    const primaryIndex = Math.floor(randomFn() * uniquePool.length);
    primaryModel = uniquePool[primaryIndex] || '';
  }

  if (!primaryModel) {
    return mergeRejections({ pair: null, failureReason: 'selection_failed' }, allRejections);
  }

  // Reject a forced challenger that is an uncertified native
  let forcedChallengerModel = opts.forcedChallengerModel;
  if (forcedChallengerModel && opts.repoDir) {
    const { models, rejections } = filterEligibleChallengeCandidates([forcedChallengerModel], 'implementation', opts.repoDir, opts.now);
    if (rejections.length > 0) {
      allRejections.push(...rejections);
    }
    if (models.length === 0) {
      forcedChallengerModel = undefined;
    }
  }

  const challengerSelection = resolveChallengerModel(uniquePool, primaryModel, forcedChallengerModel, randomFn, {
    stage: 'implementation',
    coverage: opts.coverage,
    rotationSeed: opts.rotationSeed,
    recommendedChallengerModel: opts.recommendedChallengerModel,
  });
  if (!challengerSelection.model) {
    return mergeRejections({ pair: null, failureReason: 'selection_failed' }, allRejections);
  }

  const result = finalizeChallengePairWithReason(
    withSelectionMetadata({
      ...buildChallengeEntries(opts, agentMap, defaultAgent, primaryModel, challengerSelection.model, opts.repoDir),
      challengeStage: 'implementation',
    }, challengerSelection),
    uniquePool,
    forcedChallengerModel,
    agentMap,
    defaultAgent,
    randomFn,
    opts.repoDir,
    opts.now,
    {
      coverage: opts.coverage,
      rotationSeed: opts.rotationSeed,
      recommendedChallengerModel: opts.recommendedChallengerModel,
    },
  );
  return mergeRejections(result, allRejections);
}

/**
 * Build the bare primary/challenger entry pair for the given coder models.
 * Does not enforce model distinctness — stage-varied pairs deliberately share
 * the coder and differ on planner or reviewer instead.
 */
function buildChallengeEntries(
  opts: { pairId: string; issueId: string; slug: string },
  agentMap: Record<string, string>,
  defaultAgent: string,
  primaryModel: string,
  challengerModel: string,
  repoDir?: string,
): ChallengePairSelection {
  const primarySlug = deriveChallengeSlug(opts.slug, 'primary');
  const challengerSlug = deriveChallengeSlug(opts.slug, 'challenger');

  return {
    pairId: opts.pairId,
    primary: {
      key: opts.issueId,
      issueId: opts.issueId,
      slug: primarySlug,
      branch: deriveChallengeBranch(opts.slug, 'primary'),
      role: 'primary',
      model: primaryModel,
      agent: resolveAgent(primaryModel, agentMap, defaultAgent, repoDir, 'coding'),
      planner: '',
      plannerAgent: '',
      reviewer: '',
      reviewerAgent: '',
      planDepth: '',
      codeDepth: '',
      reviewMode: '',
    },
    challenger: {
      key: deriveChallengerKey(opts.issueId),
      issueId: opts.issueId,
      slug: challengerSlug,
      branch: deriveChallengeBranch(opts.slug, 'challenger'),
      role: 'challenger',
      model: challengerModel,
      agent: resolveAgent(challengerModel, agentMap, defaultAgent, repoDir, 'coding'),
      planner: '',
      plannerAgent: '',
      reviewer: '',
      reviewerAgent: '',
      planDepth: '',
      codeDepth: '',
      reviewMode: '',
    },
  };
}

/**
 * Override the challenger's varied stage model after route fields are applied,
 * keeping the single-variable experiment property.
 */
function applyStageVariation(
  pair: ChallengePairSelection,
  stage: ChallengeStage,
  challengerVaried: string,
  agentMap: Record<string, string>,
  defaultAgent: string,
  repoDir?: string,
): ChallengePairSelection {
  if (stage === 'plan') {
    return {
      ...pair,
      challengeStage: stage,
      challenger: {
        ...pair.challenger,
        planner: challengerVaried,
        plannerAgent: resolveOptionalAgent(challengerVaried, agentMap, defaultAgent, repoDir, 'planning'),
      },
    };
  }
  if (stage === 'review') {
    return {
      ...pair,
      challengeStage: stage,
      challenger: {
        ...pair.challenger,
        reviewer: challengerVaried,
        reviewerAgent: resolveOptionalAgent(challengerVaried, agentMap, defaultAgent, repoDir, 'review'),
      },
    };
  }
  return { ...pair, challengeStage: stage };
}

function buildStageVariedPair(
  pair: ChallengePairSelection,
  stage: ChallengeStage,
  challengerVaried: string,
  agentMap: Record<string, string>,
  defaultAgent: string,
  repoDir?: string,
): ChallengePairSelection {
  const nextChallenger: ChallengeTaskEntry = {
    ...pair.challenger,
    model: pair.primary.model,
    agent: pair.primary.agent,
    planner: pair.primary.planner,
    plannerAgent: pair.primary.plannerAgent,
    reviewer: pair.primary.reviewer,
    reviewerAgent: pair.primary.reviewerAgent,
  };

  if (stage === 'implementation') {
    nextChallenger.model = challengerVaried;
    nextChallenger.agent = resolveAgent(challengerVaried, agentMap, defaultAgent, repoDir, 'coding');
    return {
      ...pair,
      challengeStage: stage,
      challenger: nextChallenger,
    };
  }

  return applyStageVariation(
    {
      ...pair,
      challengeStage: stage,
      challenger: nextChallenger,
    },
    stage,
    challengerVaried,
    agentMap,
    defaultAgent,
    repoDir,
  );
}

function candidateStages(pair: ChallengePairSelection): ChallengeStage[] {
  const preferred = pair.challengeStage || 'implementation';
  return [...new Set([preferred, 'implementation', 'plan', 'review'])];
}

function primaryVariedModelForStage(pair: ChallengePairSelection, stage: ChallengeStage): string {
  if (stage === 'plan') {
    return pair.primary.planner.trim();
  }
  if (stage === 'review') {
    return pair.primary.reviewer.trim();
  }
  return pair.primary.model.trim();
}

function finalizeChallengePair(
  pair: ChallengePairSelection,
  pool: string[],
  forcedChallengerModel: string | undefined,
  agentMap: Record<string, string>,
  defaultAgent: string,
  randomFn: () => number,
  repoDir?: string,
  now?: Date,
  selectionOpts?: ChallengerSelectionOptions,
): ChallengePairSelection | null {
  return finalizeChallengePairWithReason(
    pair,
    pool,
    forcedChallengerModel,
    agentMap,
    defaultAgent,
    randomFn,
    repoDir,
    now,
    selectionOpts,
  ).pair;
}

function finalizeChallengePairWithReason(
  pair: ChallengePairSelection,
  pool: string[],
  forcedChallengerModel: string | undefined,
  agentMap: Record<string, string>,
  defaultAgent: string,
  randomFn: () => number,
  repoDir?: string,
  now?: Date,
  selectionOpts?: ChallengerSelectionOptions,
): ChallengePairSelectionResult {
  if (
    listVariedRoutingDimensions(
      routingMetaFromChallengeEntry(pair.primary),
      routingMetaFromChallengeEntry(pair.challenger),
    ).length > 0
  ) {
    return { pair };
  }

  const allRejections: ChallengeNativeRejection[] = [];

  for (const stage of candidateStages(pair)) {
    const primaryVaried = primaryVariedModelForStage(pair, stage);
    if (!primaryVaried) {
      continue;
    }

    // Re-filter the pool for the specific phase required by this candidate stage so that
    // a native model cert'd for patch cannot be selected for a plan (workflow-phase) slot.
    const { models: stagePool, rejections: stageRejections } =
      filterEligibleChallengeCandidates(pool, stage, repoDir, now);
    allRejections.push(...stageRejections);

    const challengerSelection = chooseDistinctStageModel(stagePool, primaryVaried, forcedChallengerModel, randomFn, {
      ...selectionOpts,
      stage,
    });
    if (!challengerSelection.model) {
      continue;
    }

    const repaired = withSelectionMetadata(buildStageVariedPair(
      pair,
      stage,
      challengerSelection.model,
      agentMap,
      defaultAgent,
      repoDir,
    ), challengerSelection);
    if (
      listVariedRoutingDimensions(
        routingMetaFromChallengeEntry(repaired.primary),
        routingMetaFromChallengeEntry(repaired.challenger),
      ).length > 0
    ) {
      return mergeRejections({ pair: repaired }, allRejections);
    }
  }

  return mergeRejections({ pair: null, failureReason: NO_VALID_CHALLENGE_DIVERGENCE_REASON }, allRejections);
}

export function pickChallengeWorkflows(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    prompt: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    challengeStage?: ChallengeStage;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    routeFn?: (prompt: string, options?: { repoDir?: string }) => WorkflowRouteDecision;
  } & ChallengeCoverageOptions,
): ChallengePairSelection | null {
  return pickChallengeWorkflowsWithReason(pool, opts).pair;
}

export function pickChallengeWorkflowsWithReason(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    prompt: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    challengeStage?: ChallengeStage;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    now?: Date;
    routeFn?: (prompt: string, options?: { repoDir?: string }) => WorkflowRouteDecision;
  } & ChallengeCoverageOptions,
): ChallengePairSelectionResult {
  const uniquePool = uniqueNonEmpty(pool);
  const randomFn = opts.randomFn || Math.random;
  const defaultAgent = opts.defaultAgent || 'claude';
  const agentMap = opts.agentMap || {};
  const routeFn = opts.routeFn || routeWorkflow;
  const requestedStage = opts.challengeStage || 'implementation';

  // First, get the base coder selection (shared when a non-coder stage varies)
  const primarySelection = selectCertifiedImplementationPrimary(uniquePool, opts.primaryModel, {
    repoDir: opts.repoDir,
    now: opts.now,
    randomFn,
  });
  const allRejections: ChallengeNativeRejection[] = [...primarySelection.rejections];
  if (!primarySelection.model) {
    return mergeRejections(
      { pair: null, failureReason: primarySelection.failureReason || 'selection_failed' },
      allRejections,
    );
  }
  const primaryModel = primarySelection.model;

  // Route the workflow once to get planner/reviewer/depths
  const routing = routeFn(opts.prompt, { repoDir: opts.repoDir });

  // Fall back to coder variation when the route lacks the requested stage model
  const stage: ChallengeStage = requestedStage === 'plan' && !(routing.planner || '').trim()
    ? 'implementation'
    : requestedStage === 'review' && !(routing.reviewer || '').trim()
      ? 'implementation'
      : requestedStage;
  const primaryVaried = stage === 'plan'
    ? routing.planner.trim()
    : stage === 'review'
      ? routing.reviewer.trim()
      : primaryModel;

  // Filter the candidate pool for the cert phase required by this stage
  const { models: certifiedPool, rejections: nativeRejections } =
    filterEligibleChallengeCandidates(uniquePool, stage, opts.repoDir, opts.now);
  allRejections.push(...nativeRejections);

  // Reject a forced challenger that is an uncertified native for this stage
  let forcedChallengerModel = opts.forcedChallengerModel;
  if (forcedChallengerModel && opts.repoDir) {
    const { models, rejections } = filterEligibleChallengeCandidates([forcedChallengerModel], stage, opts.repoDir, opts.now);
    if (rejections.length > 0) {
      allRejections.push(...rejections);
    }
    if (models.length === 0) {
      forcedChallengerModel = undefined;
    }
  }

  const challengerSelection = resolveChallengerModel(certifiedPool, primaryVaried, forcedChallengerModel, randomFn, {
    stage,
    coverage: opts.coverage,
    rotationSeed: opts.rotationSeed,
    recommendedChallengerModel: opts.recommendedChallengerModel,
  });
  if (!challengerSelection.model) {
    return mergeRejections({ pair: null, failureReason: 'selection_failed' }, allRejections);
  }
  const challengerVaried = challengerSelection.model;

  // Exactly one stage differs between primary and challenger; the other two
  // stages (and all depths) are shared so outcomes attribute to one variable.
  const challengerCoder = stage === 'implementation' ? challengerVaried : primaryModel;
  const challengerPlanner = stage === 'plan' ? challengerVaried : routing.planner;
  const challengerReviewer = stage === 'review' ? challengerVaried : routing.reviewer;
  const primarySlug = deriveChallengeSlug(opts.slug, 'primary');
  const challengerSlug = deriveChallengeSlug(opts.slug, 'challenger');

  const result = finalizeChallengePairWithReason(
    withSelectionMetadata({
      pairId: opts.pairId,
      challengeStage: stage,
      primary: {
        key: opts.issueId,
        issueId: opts.issueId,
        slug: primarySlug,
        branch: deriveChallengeBranch(opts.slug, 'primary'),
        role: 'primary',
        model: primaryModel,
        agent: resolveAgent(primaryModel, agentMap, defaultAgent, opts.repoDir, 'coding'),
        planner: routing.planner,
        plannerAgent: resolveOptionalAgent(routing.planner, agentMap, defaultAgent, opts.repoDir, 'planning'),
        reviewer: routing.reviewer,
        reviewerAgent: resolveOptionalAgent(routing.reviewer, agentMap, defaultAgent, opts.repoDir, 'review'),
        planDepth: routing.planDepth,
        codeDepth: routing.codeDepth,
        reviewMode: routing.reviewRecommended,
      },
      challenger: {
        key: deriveChallengerKey(opts.issueId),
        issueId: opts.issueId,
        slug: challengerSlug,
        branch: deriveChallengeBranch(opts.slug, 'challenger'),
        role: 'challenger',
        model: challengerCoder,
        agent: resolveAgent(challengerCoder, agentMap, defaultAgent, opts.repoDir, 'coding'),
        planner: challengerPlanner,
        plannerAgent: resolveOptionalAgent(challengerPlanner, agentMap, defaultAgent, opts.repoDir, 'planning'),
        reviewer: challengerReviewer,
        reviewerAgent: resolveOptionalAgent(challengerReviewer, agentMap, defaultAgent, opts.repoDir, 'review'),
        planDepth: routing.planDepth,
        codeDepth: routing.codeDepth,
        reviewMode: routing.reviewRecommended,
      },
    }, challengerSelection),
    certifiedPool,
    forcedChallengerModel,
    agentMap,
    defaultAgent,
    randomFn,
    opts.repoDir,
    opts.now,
    {
      coverage: opts.coverage,
      rotationSeed: opts.rotationSeed,
      recommendedChallengerModel: opts.recommendedChallengerModel,
    },
  );
  return mergeRejections(result, allRejections);
}

function resolveOptionalAgent(
  modelId: string | undefined,
  agentMap: Record<string, string>,
  defaultAgent: string,
  repoDir?: string,
  phase: AgentResolutionPhase = 'coding',
): string {
  if (!modelId) {
    return '';
  }
  const resolution = tryResolveAgent(modelId, agentMap, defaultAgent, repoDir, phase);
  return resolution.ok ? resolution.agent : '';
}

function applyRouteSnapshot(
  pair: ChallengePairSelection,
  route: RouteArtifactSnapshot,
  agentMap: Record<string, string>,
  defaultAgent: string,
  repoDir?: string,
  fallback?: RouteArtifactSnapshot | null,
): ChallengePairSelection {
  const planner = route.planner || fallback?.planner || '';
  const planDepth = route.planDepth || fallback?.planDepth || '';

  const withRoute = (entry: ChallengeTaskEntry): ChallengeTaskEntry => ({
    ...entry,
    planner,
    plannerAgent: resolveOptionalAgent(planner, agentMap, defaultAgent, repoDir, 'planning'),
    reviewer: route.reviewer,
    reviewerAgent: resolveOptionalAgent(route.reviewer, agentMap, defaultAgent, repoDir, 'review'),
    planDepth,
    codeDepth: route.codeDepth,
    reviewMode: route.reviewMode,
  });

  return {
    ...pair,
    primary: withRoute(pair.primary),
    challenger: withRoute(pair.challenger),
  };
}

function buildPairFromRouteSnapshot(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    challengeStage?: ChallengeStage;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    now?: Date;
  } & ChallengeCoverageOptions,
  route: RouteArtifactSnapshot,
  fallback?: RouteArtifactSnapshot | null,
): ChallengePairSelection | null {
  return buildPairFromRouteSnapshotWithReason(pool, opts, route, fallback).pair;
}

function buildPairFromRouteSnapshotWithReason(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    challengeStage?: ChallengeStage;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    now?: Date;
  } & ChallengeCoverageOptions,
  route: RouteArtifactSnapshot,
  fallback?: RouteArtifactSnapshot | null,
): ChallengePairSelectionResult {
  const agentMap = opts.agentMap || {};
  const defaultAgent = opts.defaultAgent || 'claude';
  const requestedStage = opts.challengeStage || 'implementation';
  const requestedPrimaryCoder = opts.primaryModel?.trim() || route.coder;

  // Fall back to coder variation when the route snapshot lacks the requested
  // stage model (bootstrap artifacts may omit the planner).
  const primaryVaried = requestedStage === 'plan'
    ? (route.planner || fallback?.planner || '').trim()
    : requestedStage === 'review'
      ? (route.reviewer || '').trim()
      : '';
  const stage: ChallengeStage = requestedStage !== 'implementation' && primaryVaried
    ? requestedStage
    : 'implementation';

  if (stage === 'implementation') {
    const selection = pickChallengeModelsWithReason(pool, {
      pairId: opts.pairId,
      issueId: opts.issueId,
      slug: opts.slug,
      primaryModel: requestedPrimaryCoder,
      forcedChallengerModel: opts.forcedChallengerModel,
      agentMap: opts.agentMap,
      defaultAgent: opts.defaultAgent,
      randomFn: opts.randomFn,
      repoDir: opts.repoDir,
      now: opts.now,
      coverage: opts.coverage,
      rotationSeed: opts.rotationSeed,
      recommendedChallengerModel: opts.recommendedChallengerModel,
    });

    if (!selection.pair) {
      return selection;
    }

    const result = finalizeChallengePairWithReason(
      applyRouteSnapshot(selection.pair, route, agentMap, defaultAgent, opts.repoDir, fallback),
      pool,
      opts.forcedChallengerModel,
      agentMap,
      defaultAgent,
      opts.randomFn || Math.random,
      opts.repoDir,
      opts.now,
      {
        coverage: opts.coverage,
        rotationSeed: opts.rotationSeed,
        recommendedChallengerModel: opts.recommendedChallengerModel,
      },
    );
    return mergeRejections(result, selection.nativeCertificationRejections || []);
  }

  const primarySelection = selectCertifiedImplementationPrimary(pool, requestedPrimaryCoder, {
    repoDir: opts.repoDir,
    now: opts.now,
    randomFn: opts.randomFn || Math.random,
  });
  const allRejections: ChallengeNativeRejection[] = [...primarySelection.rejections];
  if (!primarySelection.model) {
    return mergeRejections(
      { pair: null, failureReason: primarySelection.failureReason || 'selection_failed' },
      allRejections,
    );
  }
  const primaryCoder = primarySelection.model;

  // Filter pool for the non-implementation stage's cert requirements
  const { models: certifiedPool, rejections: nativeRejections } =
    filterEligibleChallengeCandidates(uniqueNonEmpty(pool), stage, opts.repoDir, opts.now);
  allRejections.push(...nativeRejections);

  // Reject a forced challenger that is an uncertified native for this stage
  let forcedChallengerModel = opts.forcedChallengerModel;
  if (forcedChallengerModel && opts.repoDir) {
    const { models, rejections } = filterEligibleChallengeCandidates([forcedChallengerModel], stage, opts.repoDir, opts.now);
    if (rejections.length > 0) {
      allRejections.push(...rejections);
    }
    if (models.length === 0) {
      forcedChallengerModel = undefined;
    }
  }

  const challengerSelection = resolveChallengerModel(
    certifiedPool,
    primaryVaried,
    forcedChallengerModel,
    opts.randomFn || Math.random,
    {
      stage,
      coverage: opts.coverage,
      rotationSeed: opts.rotationSeed,
      recommendedChallengerModel: opts.recommendedChallengerModel,
    },
  );
  if (!challengerSelection.model) {
    return mergeRejections({ pair: null, failureReason: 'selection_failed' }, allRejections);
  }
  const challengerVaried = challengerSelection.model;

  // Same coder on both sides; route fields applied, then the varied stage
  // overridden on the challenger.
  const pair = applyRouteSnapshot(
    buildChallengeEntries(opts, agentMap, defaultAgent, primaryCoder, primaryCoder, opts.repoDir),
    route,
    agentMap,
    defaultAgent,
    opts.repoDir,
    fallback,
  );
  const result = finalizeChallengePairWithReason(
    withSelectionMetadata(
      applyStageVariation(pair, stage, challengerVaried, agentMap, defaultAgent, opts.repoDir),
      challengerSelection,
    ),
    certifiedPool,
    forcedChallengerModel,
    agentMap,
    defaultAgent,
    opts.randomFn || Math.random,
    opts.repoDir,
    opts.now,
    {
      coverage: opts.coverage,
      rotationSeed: opts.rotationSeed,
      recommendedChallengerModel: opts.recommendedChallengerModel,
    },
  );
  return mergeRejections(result, allRejections);
}

export function pickChallengeWorkflowsWithContext(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    prompt: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    challengeStage?: ChallengeStage;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    now?: Date;
    routeFn?: (prompt: string, options?: { repoDir?: string }) => WorkflowRouteDecision;
  } & ChallengeCoverageOptions,
  routeArtifacts: {
    bootstrap: RouteArtifactSnapshot | null;
    expanded: RouteArtifactSnapshot | null;
  },
): (ChallengePairSelection & { routeContext: ChallengeRouteContext }) | null {
  return pickChallengeWorkflowsWithContextAndReason(pool, opts, routeArtifacts).pair;
}

export function pickChallengeWorkflowsWithContextAndReason(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    prompt: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    challengeStage?: ChallengeStage;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    now?: Date;
    routeFn?: (prompt: string, options?: { repoDir?: string }) => WorkflowRouteDecision;
  } & ChallengeCoverageOptions,
  routeArtifacts: {
    bootstrap: RouteArtifactSnapshot | null;
    expanded: RouteArtifactSnapshot | null;
  },
): ChallengePairSelectionResult<ChallengePairSelection & { routeContext: ChallengeRouteContext }> {
  const bootstrapRoute = routeArtifacts.bootstrap || undefined;
  const expandedRoute = routeArtifacts.expanded || undefined;

  if (!expandedRoute) {
    const selection = bootstrapRoute
      ? buildPairFromRouteSnapshotWithReason(pool, opts, bootstrapRoute)
      : pickChallengeWorkflowsWithReason(pool, opts);
    if (!selection.pair) {
      return selection;
    }
    return {
      pair: {
        ...selection.pair,
        routeContext: {
          decisionSource: 'bootstrap',
          ...(bootstrapRoute ? { bootstrapRoute } : {}),
        },
      },
      ...(selection.nativeCertificationRejections ? { nativeCertificationRejections: selection.nativeCertificationRejections } : {}),
    };
  }

  if (!bootstrapRoute) {
    const selection = buildPairFromRouteSnapshotWithReason(pool, {
      ...opts,
      primaryModel: expandedRoute.coder,
    }, expandedRoute);
    if (!selection.pair) {
      return selection;
    }
    return {
      pair: {
        ...selection.pair,
        routeContext: {
          decisionSource: 'expanded',
          expandedRoute,
        },
      },
      ...(selection.nativeCertificationRejections ? { nativeCertificationRejections: selection.nativeCertificationRejections } : {}),
    };
  }

  const materiality = routeChangedMaterially(bootstrapRoute, expandedRoute, opts.repoDir);
  if (materiality.changed) {
    const selection = buildPairFromRouteSnapshotWithReason(pool, {
      ...opts,
      primaryModel: expandedRoute.coder,
    }, expandedRoute, bootstrapRoute);
    if (!selection.pair) {
      return selection;
    }
    return {
      pair: {
        ...selection.pair,
        routeContext: {
          decisionSource: 'expanded',
          bootstrapRoute,
          expandedRoute,
        },
      },
      ...(selection.nativeCertificationRejections ? { nativeCertificationRejections: selection.nativeCertificationRejections } : {}),
    };
  }

  const selection = buildPairFromRouteSnapshotWithReason(pool, {
    ...opts,
    primaryModel: opts.primaryModel?.trim() || bootstrapRoute.coder,
  }, bootstrapRoute);
  if (!selection.pair) {
    return selection;
  }

  return {
    pair: {
      ...selection.pair,
      routeContext: {
        decisionSource: 'preserved',
        bootstrapRoute,
        expandedRoute,
        refreshRationale: 'expanded route matches bootstrap on coder class/depth',
      },
    },
    ...(selection.nativeCertificationRejections ? { nativeCertificationRejections: selection.nativeCertificationRejections } : {}),
  };
}

export function getNoValidChallengeDivergenceReason(): string {
  return NO_VALID_CHALLENGE_DIVERGENCE_REASON;
}

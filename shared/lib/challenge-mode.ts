import type { ChallengeRecommendation } from './challenge-scheduler.ts';
import { loadWavemillConfig, type ChallengeConfig, type RouterConfig } from './config.ts';
import { isDeepSeekModel } from './deepseek-provider.ts';
import { getEffectiveRegistry, getModel } from './model-registry.ts';
import { resolveAgent } from './model-router.ts';
export { routeChangedMaterially } from './route-artifact.ts';
import { routeChangedMaterially, type RouteArtifactSnapshot } from './route-artifact.ts';
import { routeWorkflow, type WorkflowRouteDecision } from './workflow-router.ts';

export type ChallengeRole = 'primary' | 'challenger';
export type ChallengeDecisionSource = 'bootstrap' | 'expanded' | 'preserved';

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
  return getChallengeModelPool(config.challenge, config.router);
}

export function getChallengeModelPool(
  challengeConfig?: ChallengeConfig,
  routerConfig?: RouterConfig,
): string[] {
  const configured = challengeConfig?.models;
  if (Array.isArray(configured)) {
    return filterDeepSeekChallengeModels(configured, challengeConfig).models;
  }

  return filterDeepSeekChallengeModels(routerConfig?.models || [], challengeConfig).models;
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
  const candidates = uniqueNonEmpty(pool).filter((model) => model !== primaryModel);
  if (candidates.length === 0) {
    return null;
  }

  const index = Math.floor(randomFn() * candidates.length);
  return candidates[index] || null;
}

function resolveChallengerModel(
  pool: string[],
  primaryModel: string,
  forced: string | undefined,
  randomFn: () => number,
): string | null {
  const trimmed = forced?.trim();
  if (trimmed && trimmed !== primaryModel && pool.includes(trimmed)) {
    return trimmed;
  }
  return chooseDistinctChallengerModel(pool, primaryModel, randomFn);
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
    && uniqueNonEmpty(opts.pool).includes(challenger as string)
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
  const uniquePool = uniqueNonEmpty(pool);
  const randomFn = opts.randomFn || Math.random;
  const defaultAgent = opts.defaultAgent || 'claude';
  const agentMap = opts.agentMap || {};

  let primaryModel = opts.primaryModel?.trim() || '';
  if (!primaryModel) {
    if (!canRunChallenge(uniquePool)) {
      return null;
    }
    const primaryIndex = Math.floor(randomFn() * uniquePool.length);
    primaryModel = uniquePool[primaryIndex] || '';
  }

  if (!primaryModel) {
    return null;
  }

  const challengerModel = resolveChallengerModel(uniquePool, primaryModel, opts.forcedChallengerModel, randomFn);
  if (!challengerModel) {
    return null;
  }

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
      agent: resolveAgent(primaryModel, agentMap, defaultAgent),
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
      agent: resolveAgent(challengerModel, agentMap, defaultAgent),
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

export function pickChallengeWorkflows(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    prompt: string;
    primaryModel?: string;
    forcedChallengerModel?: string;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    routeFn?: (prompt: string, options?: { repoDir?: string }) => WorkflowRouteDecision;
  },
): ChallengePairSelection | null {
  const uniquePool = uniqueNonEmpty(pool);
  const randomFn = opts.randomFn || Math.random;
  const defaultAgent = opts.defaultAgent || 'claude';
  const agentMap = opts.agentMap || {};
  const routeFn = opts.routeFn || routeWorkflow;

  // First, get the base model selection (primary and challenger coders)
  let primaryModel = opts.primaryModel?.trim() || '';
  if (!primaryModel) {
    if (!canRunChallenge(uniquePool)) {
      return null;
    }
    const primaryIndex = Math.floor(randomFn() * uniquePool.length);
    primaryModel = uniquePool[primaryIndex] || '';
  }

  if (!primaryModel) {
    return null;
  }

  const challengerModel = resolveChallengerModel(uniquePool, primaryModel, opts.forcedChallengerModel, randomFn);
  if (!challengerModel) {
    return null;
  }

  // Route the workflow once to get planner/reviewer/depths
  const routing = routeFn(opts.prompt, { repoDir: opts.repoDir });

  // Both primary and challenger use the same planner/reviewer/depths
  // but different coder models
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
      agent: resolveAgent(primaryModel, agentMap, defaultAgent),
      planner: routing.planner,
      plannerAgent: resolveAgent(routing.planner, agentMap, defaultAgent),
      reviewer: routing.reviewer,
      reviewerAgent: resolveAgent(routing.reviewer, agentMap, defaultAgent),
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
      model: challengerModel,
      agent: resolveAgent(challengerModel, agentMap, defaultAgent),
      planner: routing.planner,
      plannerAgent: resolveAgent(routing.planner, agentMap, defaultAgent),
      reviewer: routing.reviewer,
      reviewerAgent: resolveAgent(routing.reviewer, agentMap, defaultAgent),
      planDepth: routing.planDepth,
      codeDepth: routing.codeDepth,
      reviewMode: routing.reviewRecommended,
    },
  };
}

function resolveOptionalAgent(
  modelId: string | undefined,
  agentMap: Record<string, string>,
  defaultAgent: string,
  repoDir?: string,
): string {
  if (!modelId) {
    return '';
  }
  return resolveAgent(modelId, agentMap, defaultAgent, repoDir);
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
    plannerAgent: resolveOptionalAgent(planner, agentMap, defaultAgent, repoDir),
    reviewer: route.reviewer,
    reviewerAgent: resolveOptionalAgent(route.reviewer, agentMap, defaultAgent, repoDir),
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
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
  },
  route: RouteArtifactSnapshot,
  fallback?: RouteArtifactSnapshot | null,
): ChallengePairSelection | null {
  const pair = pickChallengeModels(pool, {
    pairId: opts.pairId,
    issueId: opts.issueId,
    slug: opts.slug,
    primaryModel: opts.primaryModel?.trim() || route.coder,
    forcedChallengerModel: opts.forcedChallengerModel,
    agentMap: opts.agentMap,
    defaultAgent: opts.defaultAgent,
    randomFn: opts.randomFn,
  });

  if (!pair) {
    return null;
  }

  return applyRouteSnapshot(
    pair,
    route,
    opts.agentMap || {},
    opts.defaultAgent || 'claude',
    opts.repoDir,
    fallback,
  );
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
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
    routeFn?: (prompt: string, options?: { repoDir?: string }) => WorkflowRouteDecision;
  },
  routeArtifacts: {
    bootstrap: RouteArtifactSnapshot | null;
    expanded: RouteArtifactSnapshot | null;
  },
): (ChallengePairSelection & { routeContext: ChallengeRouteContext }) | null {
  const bootstrapRoute = routeArtifacts.bootstrap || undefined;
  const expandedRoute = routeArtifacts.expanded || undefined;

  if (!expandedRoute) {
    const pair = bootstrapRoute
      ? buildPairFromRouteSnapshot(pool, opts, bootstrapRoute)
      : pickChallengeWorkflows(pool, opts);
    if (!pair) {
      return null;
    }
    return {
      ...pair,
      routeContext: {
        decisionSource: 'bootstrap',
        ...(bootstrapRoute ? { bootstrapRoute } : {}),
      },
    };
  }

  if (!bootstrapRoute) {
    const pair = buildPairFromRouteSnapshot(pool, {
      ...opts,
      primaryModel: expandedRoute.coder,
    }, expandedRoute);
    if (!pair) {
      return null;
    }
    return {
      ...pair,
      routeContext: {
        decisionSource: 'expanded',
        expandedRoute,
      },
    };
  }

  const materiality = routeChangedMaterially(bootstrapRoute, expandedRoute, opts.repoDir);
  if (materiality.changed) {
    const pair = buildPairFromRouteSnapshot(pool, {
      ...opts,
      primaryModel: expandedRoute.coder,
    }, expandedRoute, bootstrapRoute);
    if (!pair) {
      return null;
    }
    return {
      ...pair,
      routeContext: {
        decisionSource: 'expanded',
        bootstrapRoute,
        expandedRoute,
      },
    };
  }

  const pair = buildPairFromRouteSnapshot(pool, {
    ...opts,
    primaryModel: opts.primaryModel?.trim() || bootstrapRoute.coder,
  }, bootstrapRoute);
  if (!pair) {
    return null;
  }

  return {
    ...pair,
    routeContext: {
      decisionSource: 'preserved',
      bootstrapRoute,
      expandedRoute,
      refreshRationale: 'expanded route matches bootstrap on coder class/depth',
    },
  };
}

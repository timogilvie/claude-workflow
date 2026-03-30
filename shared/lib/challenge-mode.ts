import { loadWavemillConfig, type ChallengeConfig, type RouterConfig } from './config.ts';
import { resolveAgent } from './model-router.ts';
import { routeWorkflow, type WorkflowRouteDecision } from './workflow-router.ts';

export type ChallengeRole = 'primary' | 'challenger';

export interface ChallengeTaskEntry {
  key: string;
  issueId: string;
  slug: string;
  branch: string;
  role: ChallengeRole;
  model: string;       // coder model
  agent: string;       // coder agent
  // Workflow routing fields:
  planner: string;
  reviewer: string;
  planDepth: string;    // 'light' | 'deep'
  codeDepth: string;    // 'light' | 'medium' | 'deep'
  reviewMode: string;   // 'none' | 'static' | 'llm' | 'static+llm'
  plannerAgent: string;
  reviewerAgent: string;
}

export interface ChallengePairSelection {
  pairId: string;
  primary: ChallengeTaskEntry;
  challenger: ChallengeTaskEntry;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
    return uniqueNonEmpty(configured);
  }

  return uniqueNonEmpty(routerConfig?.models || []);
}

export function canRunChallenge(pool: string[]): boolean {
  return uniqueNonEmpty(pool).length >= 2;
}

export function deriveChallengerKey(issueId: string): string {
  return `${issueId}__challenger`;
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

export function pickChallengeModels(
  pool: string[],
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    primaryModel?: string;
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

  const challengerModel = chooseDistinctChallengerModel(uniquePool, primaryModel, randomFn);
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
      reviewer: '',
      planDepth: '',
      codeDepth: '',
      reviewMode: '',
      plannerAgent: '',
      reviewerAgent: '',
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
      reviewer: '',
      planDepth: '',
      codeDepth: '',
      reviewMode: '',
      plannerAgent: '',
      reviewerAgent: '',
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
    repoDir?: string;
    primaryModel?: string;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    routeFn?: (prompt: string, options?: { repoDir?: string }) => WorkflowRouteDecision;
  },
): ChallengePairSelection | null {
  const uniquePool = uniqueNonEmpty(pool);
  const randomFn = opts.randomFn || Math.random;
  const defaultAgent = opts.defaultAgent || 'claude';
  const agentMap = opts.agentMap || {};
  const routeFn = opts.routeFn || routeWorkflow;

  // Get primary routing decision
  const primaryRouting = routeFn(opts.prompt, { repoDir: opts.repoDir });

  // Determine primary coder: use override if provided, else use router recommendation
  const primaryModel = opts.primaryModel?.trim() || primaryRouting.coder;

  if (!primaryModel) {
    return null;
  }

  // Pick distinct challenger coder
  const challengerModel = chooseDistinctChallengerModel(uniquePool, primaryModel, randomFn);
  if (!challengerModel) {
    return null;
  }

  // Get challenger routing decision (will be same planner/reviewer/depths due to deterministic routing)
  const challengerRouting = routeFn(opts.prompt, { repoDir: opts.repoDir });

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
      planner: primaryRouting.planner,
      reviewer: primaryRouting.reviewer,
      planDepth: primaryRouting.planDepth,
      codeDepth: primaryRouting.codeDepth,
      reviewMode: primaryRouting.reviewRecommended,
      plannerAgent: resolveAgent(primaryRouting.planner, agentMap, defaultAgent),
      reviewerAgent: resolveAgent(primaryRouting.reviewer, agentMap, defaultAgent),
    },
    challenger: {
      key: deriveChallengerKey(opts.issueId),
      issueId: opts.issueId,
      slug: challengerSlug,
      branch: deriveChallengeBranch(opts.slug, 'challenger'),
      role: 'challenger',
      model: challengerModel,
      agent: resolveAgent(challengerModel, agentMap, defaultAgent),
      planner: challengerRouting.planner,
      reviewer: challengerRouting.reviewer,
      planDepth: challengerRouting.planDepth,
      codeDepth: challengerRouting.codeDepth,
      reviewMode: challengerRouting.reviewRecommended,
      plannerAgent: resolveAgent(challengerRouting.planner, agentMap, defaultAgent),
      reviewerAgent: resolveAgent(challengerRouting.reviewer, agentMap, defaultAgent),
    },
  };
}

import { loadWavemillConfig, type ChallengeConfig, type RouterConfig } from './config.ts';
import { resolveAgent } from './model-router.ts';
import { routeWorkflow } from './workflow-router.ts';

export type ChallengeRole = 'primary' | 'challenger';

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
  prompt: string,
  opts: {
    pairId: string;
    issueId: string;
    slug: string;
    primaryModel?: string;
    agentMap?: Record<string, string>;
    defaultAgent?: string;
    randomFn?: () => number;
    repoDir?: string;
  },
): ChallengePairSelection | null {
  const uniquePool = uniqueNonEmpty(pool);
  const randomFn = opts.randomFn || Math.random;
  const defaultAgent = opts.defaultAgent || 'claude';
  const agentMap = opts.agentMap || {};

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

  const challengerModel = chooseDistinctChallengerModel(uniquePool, primaryModel, randomFn);
  if (!challengerModel) {
    return null;
  }

  // Route the workflow once to get planner/reviewer/depths
  const routing = routeWorkflow(prompt, { repoDir: opts.repoDir });

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

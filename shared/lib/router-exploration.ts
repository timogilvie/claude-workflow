/**
 * Stochastic exploration for router model selection.
 *
 * Converts deterministic argmax picks into configurable sampling so newer or
 * undersampled models keep receiving routing traffic. Sampling always happens
 * within the caller's already-filtered candidate list (allowlists, capability
 * constraints, disabled models), so exploration can never select an
 * ineligible model.
 *
 * @module router-exploration
 */

export type ExplorationMode = 'softmax' | 'epsilon';
export type ExplorationRole = 'planner' | 'coder' | 'reviewer';

export interface ExplorationPriorsConfig {
  enabled?: boolean;
  blendSamples?: number;
}

export interface NewModelBoostConfig {
  windowDays?: number;
  multiplier?: number;
}

export interface ExplorationConfig {
  enabled?: boolean;
  mode?: ExplorationMode;
  rate?: number;
  temperature?: number;
  topK?: number;
  ucbConstant?: number;
  priors?: ExplorationPriorsConfig;
  newModelBoost?: NewModelBoostConfig;
}

export interface ResolvedExplorationConfig {
  enabled: boolean;
  mode: ExplorationMode;
  rate: number;
  temperature: number;
  topK: number;
  ucbConstant: number;
  priorsEnabled: boolean;
  priorBlendSamples: number;
  boostWindowDays: number;
  boostMultiplier: number;
}

export interface ExplorationPick {
  index: number;
  explored: boolean;
}

export interface ExplorationAttribution {
  mode: ExplorationMode;
  explored: Array<{ role: ExplorationRole; sampled: string; argmax: string; recencyBoosted?: boolean }>;
  costGuardReverted?: boolean;
}

const DEFAULT_RATE = 0.15;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_K = 3;
const DEFAULT_UCB_CONSTANT = 0;
const DEFAULT_PRIOR_BLEND_SAMPLES = 10;
const DEFAULT_BOOST_WINDOW_DAYS = 45;
const DEFAULT_BOOST_MULTIPLIER = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function resolveExplorationConfig(raw?: ExplorationConfig): ResolvedExplorationConfig {
  return {
    enabled: raw?.enabled === true,
    mode: raw?.mode === 'softmax' ? 'softmax' : 'epsilon',
    rate: typeof raw?.rate === 'number' && Number.isFinite(raw.rate)
      ? clamp(raw.rate, 0, 1)
      : DEFAULT_RATE,
    temperature: typeof raw?.temperature === 'number' && Number.isFinite(raw.temperature)
      ? clamp(raw.temperature, 0.01, 10)
      : DEFAULT_TEMPERATURE,
    topK: Number.isInteger(raw?.topK) && (raw?.topK as number) >= 2
      ? raw?.topK as number
      : DEFAULT_TOP_K,
    ucbConstant: typeof raw?.ucbConstant === 'number' && Number.isFinite(raw.ucbConstant)
      ? clamp(raw.ucbConstant, 0, 1)
      : DEFAULT_UCB_CONSTANT,
    priorsEnabled: raw?.priors?.enabled === true,
    priorBlendSamples: Number.isInteger(raw?.priors?.blendSamples) && (raw?.priors?.blendSamples as number) >= 1
      ? raw?.priors?.blendSamples as number
      : DEFAULT_PRIOR_BLEND_SAMPLES,
    boostWindowDays: Number.isInteger(raw?.newModelBoost?.windowDays) && (raw?.newModelBoost?.windowDays as number) >= 1
      ? raw?.newModelBoost?.windowDays as number
      : DEFAULT_BOOST_WINDOW_DAYS,
    boostMultiplier: typeof raw?.newModelBoost?.multiplier === 'number'
      && Number.isFinite(raw.newModelBoost.multiplier)
      && raw.newModelBoost.multiplier >= 1
      ? clamp(raw.newModelBoost.multiplier, 1, 10)
      : DEFAULT_BOOST_MULTIPLIER,
  };
}

/**
 * Whether a model's release date falls inside the recency window. Unset or
 * unparsable dates (and future dates) are never recent.
 */
export function isWithinRecencyWindow(
  releasedAt: string | undefined,
  windowDays: number,
  nowMs: number = Date.now(),
): boolean {
  if (!releasedAt || windowDays <= 0) {
    return false;
  }
  const releasedMs = Date.parse(releasedAt);
  if (!Number.isFinite(releasedMs) || releasedMs > nowMs) {
    return false;
  }
  return (nowMs - releasedMs) / MS_PER_DAY < windowDays;
}

/**
 * Recency multiplier for a model's exploration sampling weight.
 *
 * Returns `boostMultiplier` at release time, decaying linearly to 1.0 at the
 * end of the window — and exactly 1.0 outside the window, with an unset or
 * unparsable releasedAt, or when the boost is configured off (multiplier 1).
 * No permanent thumb on the scale: long-term ranking comes from evals.
 */
export function recencyMultiplier(
  releasedAt: string | undefined,
  config: ResolvedExplorationConfig,
  nowMs: number = Date.now(),
): number {
  if (config.boostMultiplier <= 1 || !releasedAt) {
    return 1;
  }

  const releasedMs = Date.parse(releasedAt);
  if (!Number.isFinite(releasedMs) || releasedMs > nowMs) {
    return 1;
  }

  const ageDays = (nowMs - releasedMs) / MS_PER_DAY;
  if (ageDays >= config.boostWindowDays) {
    return 1;
  }

  return 1 + (config.boostMultiplier - 1) * (1 - ageDays / config.boostWindowDays);
}

/**
 * UCB-style uncertainty bonus: grows with total observations and shrinks with
 * per-candidate support, so undersampled candidates get a temporary ranking
 * boost that decays as evidence accumulates. A zero constant disables it.
 */
export function ucbBonus(
  ucbConstant: number,
  totalObservations: number,
  support: number,
): number {
  if (ucbConstant <= 0) {
    return 0;
  }
  return ucbConstant * Math.sqrt(Math.log(Math.max(totalObservations, 0) + 1) / Math.max(support, 1));
}

/**
 * Blend an empirical score with a prior, weighted by how much evidence backs
 * the empirical value: w = min(support / blendSamples, 1). Zero support means
 * pure prior; support >= blendSamples means pure empirical.
 */
export function blendWithPrior(
  empirical: number,
  prior: number,
  support: number,
  blendSamples: number,
): number {
  const weight = clamp(support / Math.max(blendSamples, 1), 0, 1);
  return clamp(weight * empirical + (1 - weight) * prior, 0, 1);
}

/**
 * Sample a candidate index from scores listed in descending preference order.
 * Index 0 is the exploit (argmax) choice; `explored` is true only when a
 * non-argmax index was selected. Returns the argmax whenever exploration is
 * disabled or there is nothing to explore.
 *
 * Epsilon mode: with probability `rate`, pick uniformly among the non-argmax
 * candidates inside the top-K window. Softmax mode: sample the top-K window
 * with probability proportional to exp(score / temperature).
 */
export function sampleCandidateIndex(
  scores: number[],
  config: ResolvedExplorationConfig,
  randomFn: () => number = Math.random,
  multipliers?: number[],
): ExplorationPick {
  if (!config.enabled || scores.length <= 1) {
    return { index: 0, explored: false };
  }

  const windowSize = Math.min(config.topK, scores.length);
  const multiplierAt = (index: number): number => {
    const value = multipliers?.[index];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
  };

  if (config.mode === 'epsilon') {
    const alternatives = windowSize - 1;
    if (alternatives <= 0 || randomFn() >= config.rate) {
      return { index: 0, explored: false };
    }
    // Sample non-argmax candidates proportionally to their recency multiplier
    // (uniform when no multipliers are supplied).
    const weights = Array.from({ length: alternatives }, (_, offset) => multiplierAt(1 + offset));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let threshold = randomFn() * total;
    for (let offset = 0; offset < alternatives; offset += 1) {
      threshold -= weights[offset];
      if (threshold <= 0) {
        return { index: 1 + offset, explored: true };
      }
    }
    return { index: windowSize - 1, explored: true };
  }

  const window = scores.slice(0, windowSize);
  const maxScore = Math.max(...window);
  const weights = window.map((score, index) => Math.exp((score - maxScore) / config.temperature) * multiplierAt(index));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let threshold = randomFn() * total;
  for (let index = 0; index < weights.length; index += 1) {
    threshold -= weights[index];
    if (threshold <= 0) {
      return { index, explored: index !== 0 };
    }
  }
  return { index: 0, explored: false };
}

export function formatExplorationReasoning(
  attribution: ExplorationAttribution,
  config: ResolvedExplorationConfig,
): string {
  if (attribution.costGuardReverted) {
    return `exploration(${config.mode}) reverted: sampled combination exceeded maxCostUsd; using exploit selection.`;
  }

  const details = attribution.explored
    .map((entry) => `${entry.role}=${entry.sampled} (argmax ${entry.argmax})${entry.recencyBoosted ? ' [recency-boosted]' : ''}`)
    .join(', ');
  const parameter = config.mode === 'epsilon'
    ? `rate=${config.rate}`
    : `temperature=${config.temperature}`;
  return `exploration(${config.mode}, ${parameter}): sampled ${details}.`;
}

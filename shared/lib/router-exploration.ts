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

export interface ExplorationConfig {
  enabled?: boolean;
  mode?: ExplorationMode;
  rate?: number;
  temperature?: number;
  topK?: number;
}

export interface ResolvedExplorationConfig {
  enabled: boolean;
  mode: ExplorationMode;
  rate: number;
  temperature: number;
  topK: number;
}

export interface ExplorationPick {
  index: number;
  explored: boolean;
}

export interface ExplorationAttribution {
  mode: ExplorationMode;
  explored: Array<{ role: ExplorationRole; sampled: string; argmax: string }>;
  costGuardReverted?: boolean;
}

const DEFAULT_RATE = 0.15;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_K = 3;

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
  };
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
): ExplorationPick {
  if (!config.enabled || scores.length <= 1) {
    return { index: 0, explored: false };
  }

  const windowSize = Math.min(config.topK, scores.length);

  if (config.mode === 'epsilon') {
    const alternatives = windowSize - 1;
    if (alternatives <= 0 || randomFn() >= config.rate) {
      return { index: 0, explored: false };
    }
    const offset = Math.min(Math.floor(randomFn() * alternatives), alternatives - 1);
    return { index: 1 + offset, explored: true };
  }

  const window = scores.slice(0, windowSize);
  const maxScore = Math.max(...window);
  const weights = window.map((score) => Math.exp((score - maxScore) / config.temperature));
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
    .map((entry) => `${entry.role}=${entry.sampled} (argmax ${entry.argmax})`)
    .join(', ');
  const parameter = config.mode === 'epsilon'
    ? `rate=${config.rate}`
    : `temperature=${config.temperature}`;
  return `exploration(${config.mode}, ${parameter}): sampled ${details}.`;
}

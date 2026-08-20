import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getEffectiveRegistry, getModel, type SupportedModelStage } from './model-registry.ts';
import { resolveWavemillAliasFromOpenRouterId } from './openrouter-catalog.ts';

/**
 * Retained for callers that want to size a floor from a central estimate.
 * `recommendedFloor` no longer applies it: the floor is derived from p95, and
 * a tail percentile already carries the headroom a multiplier would add.
 */
export const CONTEXT_FLOOR_HEADROOM_MULTIPLIER = 1.10;
/**
 * Fraction of a model's own context window at or above which an observed
 * prompt is treated as an overflow incident rather than a workload sample.
 *
 * A run whose prompt nearly filled (or exceeded) the model's window is the
 * failure the floor exists to prevent. Feeding it back in as evidence would
 * ratchet the floor upward after every incident until only the largest-context
 * models remain eligible.
 */
export const CONTEXT_OVERFLOW_SAMPLE_RATIO = 0.95;
/** Percentile the recommended floor is derived from. */
export const CONTEXT_FLOOR_PERCENTILE = 0.95;
export const CONTEXT_FLOOR_ROUNDING_TOKENS = 1024;
export const MIN_MEASURED_STAGE_SAMPLES = 3;
export const PROVISIONAL_CONTEXT_FLOOR_TOKENS = 65_536;

export interface StagePromptObservation {
  stage: SupportedModelStage;
  peakRequestTokens: number;
  source: string;
  ts?: string;
  model?: string;
  provider?: string;
  totalInputTokens?: number;
  turns?: number;
  contextWindowTokens?: number;
}

export interface StageContextFloorRecommendation {
  stage: SupportedModelStage;
  samples: number;
  /** Observations dropped because the prompt filled the model's own window. */
  discardedOverflowSamples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  recommendedFloor: number;
  provisional: boolean;
  sources: string[];
}

export const INCIDENT_SEED_OBSERVATIONS: readonly StagePromptObservation[] = Object.freeze([
  Object.freeze({
    stage: 'coding' as const,
    peakRequestTokens: 131_182,
    source: '2026-08-17 kimi-k2 provider 400, HOK-2763/HOK-2764/HOK-2766',
    ts: '2026-08-17T00:00:00.000Z',
    model: 'kimi-k2',
    provider: 'openrouter',
    contextWindowTokens: 131_072,
  }),
]);

const STAGES: readonly SupportedModelStage[] = ['expansion', 'planning', 'coding', 'review'];

export function roundUpTo1024(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return 0;
  }
  return Math.ceil(tokens / CONTEXT_FLOOR_ROUNDING_TOKENS) * CONTEXT_FLOOR_ROUNDING_TOKENS;
}

/**
 * Linear-interpolated percentile.
 *
 * The previous nearest-rank form returned the maximum for any p >= 1 - 1/n,
 * which made p95 and p99 identical to max on the small samples this module
 * actually sees (n = 13 for coding). Interpolating keeps the tail statistics
 * meaningful at small n.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0] ?? 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const rank = clamped * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

/**
 * True when the observation's prompt filled the running model's own context
 * window, i.e. the run was at or past the limit rather than exercising a
 * workload the floor should be sized for.
 */
export function isContextOverflowObservation(observation: StagePromptObservation): boolean {
  const window = observation.contextWindowTokens;
  if (!isPositiveFinite(window)) return false;
  return observation.peakRequestTokens >= window * CONTEXT_OVERFLOW_SAMPLE_RATIO;
}

export function computeStageContextFloorRecommendations(
  observations: readonly StagePromptObservation[],
): StageContextFloorRecommendation[] {
  return STAGES.map((stage) => {
    const allStageObservations = observations
      .filter((observation) => observation.stage === stage && isPositiveFinite(observation.peakRequestTokens));
    const stageObservations = allStageObservations.filter(
      (observation) => !isContextOverflowObservation(observation),
    );
    const discardedOverflowSamples = allStageObservations.length - stageObservations.length;
    const values = stageObservations.map((observation) => observation.peakRequestTokens);
    const max = values.length > 0 ? Math.max(...values) : 0;
    const provisional = values.length < MIN_MEASURED_STAGE_SAMPLES;
    const p95 = percentile(values, CONTEXT_FLOOR_PERCENTILE);
    return {
      stage,
      samples: values.length,
      discardedOverflowSamples,
      p50: percentile(values, 0.50),
      p95,
      p99: percentile(values, 0.99),
      max,
      recommendedFloor: provisional
        ? PROVISIONAL_CONTEXT_FLOOR_TOKENS
        : roundUpTo1024(p95),
      provisional,
      sources: [...new Set(stageObservations.map((observation) => observation.source))].sort(),
    };
  });
}

export function parseStagePromptObservation(line: string): StagePromptObservation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (!isSupportedModelStage(candidate.stage)) return undefined;
  if (!isPositiveFinite(candidate.peakRequestTokens)) return undefined;
  return {
    stage: candidate.stage,
    peakRequestTokens: candidate.peakRequestTokens,
    source: typeof candidate.source === 'string' && candidate.source.trim()
      ? candidate.source
      : 'stage-prompt-observations',
    ...(typeof candidate.ts === 'string' ? { ts: candidate.ts } : {}),
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    ...(typeof candidate.provider === 'string' ? { provider: candidate.provider } : {}),
    ...(isNonNegativeFinite(candidate.totalInputTokens) ? { totalInputTokens: candidate.totalInputTokens } : {}),
    ...(isNonNegativeFinite(candidate.turns) ? { turns: candidate.turns } : {}),
    ...(isPositiveFinite(candidate.contextWindowTokens) ? { contextWindowTokens: candidate.contextWindowTokens } : {}),
  };
}

export function readObservationFile(path: string): StagePromptObservation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseStagePromptObservation)
    .filter((observation): observation is StagePromptObservation => observation !== undefined);
}

export function scanNativeSessionTranscripts(rootDir: string): StagePromptObservation[] {
  if (!existsSync(rootDir)) return [];
  const transcriptPaths: string[] = [];
  collectTranscriptPaths(rootDir, transcriptPaths);
  return transcriptPaths
    .map(observationFromTranscript)
    .filter((observation): observation is StagePromptObservation => observation !== undefined);
}

export function formatStageContextFloorReport(recommendations: readonly StageContextFloorRecommendation[]): string {
  const lines = [
    'Stage context window floor recommendations',
    `Formula: floor = roundUpTo1024(p95 of non-overflow peakRequestTokens); n < ${MIN_MEASURED_STAGE_SAMPLES} => ${PROVISIONAL_CONTEXT_FLOOR_TOKENS}`,
    `Overflow samples (peak >= ${(CONTEXT_OVERFLOW_SAMPLE_RATIO * 100).toFixed(0)}% of the running model's own window) are excluded.`,
    '',
  ];
  for (const recommendation of recommendations) {
    lines.push([
      recommendation.stage,
      `n=${recommendation.samples}`,
      `overflowDropped=${recommendation.discardedOverflowSamples}`,
      `p50=${recommendation.p50}`,
      `p95=${recommendation.p95}`,
      `p99=${recommendation.p99}`,
      `max=${recommendation.max}`,
      `floor=${recommendation.recommendedFloor}`,
      `provisional=${recommendation.provisional}`,
    ].join(' '));
  }
  lines.push('', 'Ready-to-paste STAGE_CONTEXT_WINDOW_FLOORS:');
  lines.push('export const STAGE_CONTEXT_WINDOW_FLOORS = Object.freeze({');
  for (const recommendation of recommendations) {
    const sourceSummary = recommendation.sources.slice(0, 3).join('; ') || 'no measured samples';
    lines.push(`  ${recommendation.stage}: {`);
    lines.push(`    floorTokens: ${formatNumericLiteral(recommendation.recommendedFloor)},`);
    lines.push(`    provenance: ${JSON.stringify(`n=${recommendation.samples}; overflowDropped=${recommendation.discardedOverflowSamples}; p50=${recommendation.p50}; p95=${recommendation.p95}; max=${recommendation.max}; formula=roundUpTo1024(p95 of non-overflow samples); sources=${sourceSummary}`)},`);
    lines.push(`    provisional: ${recommendation.provisional},`);
    lines.push('  },');
  }
  lines.push('} as const);');
  return lines.join('\n');
}

function collectTranscriptPaths(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTranscriptPaths(fullPath, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    if (!fullPath.includes('/native-sessions/')) continue;
    if (stageFromTranscriptName(entry.name)) {
      out.push(fullPath);
    }
  }
}

function observationFromTranscript(path: string): StagePromptObservation | undefined {
  const stage = stageFromTranscriptName(basename(path));
  if (!stage) return undefined;
  let peakRequestTokens = 0;
  let totalInputTokens = 0;
  let turns = 0;
  let providerModelId: string | undefined;
  let provider: string | undefined;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (!providerModelId && typeof record.model === 'string' && record.model.trim()) {
        providerModelId = record.model;
      }
      if (!provider && typeof record.provider === 'string' && record.provider.trim()) {
        provider = record.provider;
      }
    }
    const usage = extractUsage(parsed);
    if (!usage) continue;
    const requestTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    peakRequestTokens = Math.max(peakRequestTokens, requestTokens);
    totalInputTokens += usage.input;
    turns += 1;
  }
  if (peakRequestTokens <= 0) return undefined;
  const stat = safeStat(path);
  // Attribute the run to a registry model so overflow samples (prompts that
  // filled the model's own window) can be excluded from floor derivation.
  const alias = providerModelId ? resolveWavemillAliasFromOpenRouterId(providerModelId) : null;
  const contextWindowTokens = alias
    ? getModel(getEffectiveRegistry(), alias)?.contextWindowTokens
    : undefined;
  return {
    stage,
    peakRequestTokens,
    totalInputTokens,
    turns,
    source: `native transcript ${path}`,
    ...(stat ? { ts: stat.mtime.toISOString() } : {}),
    ...(alias ? { model: alias } : {}),
    ...(provider ? { provider } : {}),
    ...(isPositiveFinite(contextWindowTokens) ? { contextWindowTokens } : {}),
  };
}

function extractUsage(value: unknown): { input: number; cacheRead: number; cacheWrite: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const usage = candidate.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as Record<string, unknown>;
  const input = normalizeToken(raw.input ?? raw.inputTokens ?? raw.prompt_tokens);
  const cacheRead = normalizeToken(raw.cacheRead ?? raw.cacheReadTokens ?? raw.cache_read_input_tokens);
  const cacheWrite = normalizeToken(raw.cacheWrite ?? raw.cacheCreationTokens ?? raw.cache_creation_input_tokens);
  if (input === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return { input, cacheRead, cacheWrite };
}

function stageFromTranscriptName(name: string): SupportedModelStage | undefined {
  if (name.startsWith('planning-')) return 'planning';
  if (name.startsWith('expansion-')) return 'expansion';
  if (name.startsWith('coding-')) return 'coding';
  if (name.includes('-review-') || name.startsWith('review-')) return 'review';
  return undefined;
}

function normalizeToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isSupportedModelStage(value: unknown): value is SupportedModelStage {
  return value === 'expansion' || value === 'planning' || value === 'coding' || value === 'review';
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function formatNumericLiteral(value: number): string {
  return value.toLocaleString('en-US').replace(/,/g, '_');
}

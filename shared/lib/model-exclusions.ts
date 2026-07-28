import {
  getEffectiveModelExclusions,
  type EffectiveModelExclusion,
  type ModelExclusionStage,
  type ModelExclusionSource,
} from './config.ts';
import type { RouterRole } from './native-agent/certification/router-filter.ts';
import type { ChallengeStage } from './challenge-scheduler.ts';

export type NormalizedModelExclusionStage = 'expansion' | 'planning' | 'coding' | 'review';

export interface ModelExclusionDiagnostic {
  modelId: string;
  stage: NormalizedModelExclusionStage;
  source: ModelExclusionSource;
  reason?: string;
}

export function normalizeModelExclusionStage(
  stage: ModelExclusionStage | RouterRole | ChallengeStage | NormalizedModelExclusionStage,
): NormalizedModelExclusionStage {
  switch (stage) {
    case 'planner':
    case 'plan':
      return 'planning';
    case 'coder':
    case 'implementation':
      return 'coding';
    case 'reviewer':
      return 'review';
    default:
      return stage;
  }
}

function exclusionAppliesToStage(
  exclusion: EffectiveModelExclusion,
  stage: NormalizedModelExclusionStage,
): boolean {
  if (!exclusion.stages || exclusion.stages.length === 0) {
    return true;
  }
  return exclusion.stages.some((candidate) => normalizeModelExclusionStage(candidate) === stage);
}

export function findModelExclusion(
  modelId: string,
  stage: ModelExclusionStage | RouterRole | ChallengeStage | NormalizedModelExclusionStage,
  repoDir?: string,
): ModelExclusionDiagnostic | undefined {
  const normalizedStage = normalizeModelExclusionStage(stage);
  const exclusions = getEffectiveModelExclusions(repoDir);
  const match = exclusions
    .filter((entry) => entry.model === modelId && exclusionAppliesToStage(entry, normalizedStage))
    .at(-1);
  if (!match) {
    return undefined;
  }
  return {
    modelId,
    stage: normalizedStage,
    source: match.source,
    ...(match.reason ? { reason: match.reason } : {}),
  };
}

export function applyModelExclusions(
  models: string[],
  stage: ModelExclusionStage | RouterRole | ChallengeStage | NormalizedModelExclusionStage,
  repoDir?: string,
): { models: string[]; exclusions: ModelExclusionDiagnostic[] } {
  const kept: string[] = [];
  const exclusions: ModelExclusionDiagnostic[] = [];

  for (const modelId of models) {
    const exclusion = findModelExclusion(modelId, stage, repoDir);
    if (exclusion) {
      exclusions.push(exclusion);
    } else {
      kept.push(modelId);
    }
  }

  return { models: kept, exclusions };
}


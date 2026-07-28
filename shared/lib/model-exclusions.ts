import { getModelsConfig, type ModelExclusionConfig } from './config.ts';
import type { DescriptorModelStage } from './model-registry.ts';

export type ModelExclusionSource = 'repo' | 'disabled-policy' | 'lifecycle';

export interface ModelExclusionDiagnostic {
  model: string;
  stage: DescriptorModelStage;
  source: ModelExclusionSource;
  reason: string;
}

export interface ApplyModelExclusionsResult {
  models: string[];
  exclusions: ModelExclusionDiagnostic[];
}

function appliesToStage(exclusion: ModelExclusionConfig, stage: DescriptorModelStage): boolean {
  return !exclusion.stages || exclusion.stages.length === 0 || exclusion.stages.includes(stage);
}

export function getConfiguredModelExclusions(
  repoDir: string | undefined,
  stage: DescriptorModelStage,
): ModelExclusionDiagnostic[] {
  return (getModelsConfig(repoDir).exclude ?? [])
    .filter((entry) => entry.model && appliesToStage(entry, stage))
    .map((entry) => ({
      model: entry.model,
      stage,
      source: 'repo' as const,
      reason: entry.reason?.trim() || 'configured model exclusion',
    }));
}

export function applyConfiguredModelExclusions(
  models: string[],
  stage: DescriptorModelStage,
  repoDir?: string,
): ApplyModelExclusionsResult {
  const exclusions = getConfiguredModelExclusions(repoDir, stage);
  if (exclusions.length === 0) {
    return { models: [...new Set(models)], exclusions: [] };
  }

  const excludedModels = new Set(exclusions.map((entry) => entry.model));
  return {
    models: [...new Set(models)].filter((modelId) => !excludedModels.has(modelId)),
    exclusions,
  };
}

export function dedupeModelExclusions(
  exclusions: readonly ModelExclusionDiagnostic[],
): ModelExclusionDiagnostic[] {
  const seen = new Set<string>();
  const deduped: ModelExclusionDiagnostic[] = [];
  for (const exclusion of exclusions) {
    const key = `${exclusion.model}\0${exclusion.stage}\0${exclusion.source}\0${exclusion.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(exclusion);
  }
  return deduped;
}

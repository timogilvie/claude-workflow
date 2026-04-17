import {
  DEFAULT_MODEL_REGISTRY,
  type ModelRegistry,
} from './model-registry.ts';
import {
  readQuotaSnapshot,
  type QuotaSnapshot,
  type QuotaStatus,
} from './quota-state.ts';

export type OperatingMode = 'normal' | 'constrained' | 'survival';

export const SURVIVAL_STATUSES: readonly QuotaStatus[] = ['exhausted'] as const;
export const CONSTRAINED_STATUSES: readonly QuotaStatus[] = ['degrading'] as const;

export function deriveOperatingMode(
  snapshot: QuotaSnapshot,
  registry: ModelRegistry = DEFAULT_MODEL_REGISTRY,
): OperatingMode {
  let hasConstrainedFrontier = false;

  for (const [modelId, entry] of Object.entries(snapshot.models)) {
    if (registry.models[modelId]?.class !== 'frontier') {
      continue;
    }

    if (SURVIVAL_STATUSES.includes(entry.status)) {
      return 'survival';
    }

    if (CONSTRAINED_STATUSES.includes(entry.status)) {
      hasConstrainedFrontier = true;
    }
  }

  return hasConstrainedFrontier ? 'constrained' : 'normal';
}

export async function getCurrentOperatingMode(repoDir?: string): Promise<OperatingMode> {
  const snapshot = readQuotaSnapshot(repoDir);
  return deriveOperatingMode(snapshot);
}

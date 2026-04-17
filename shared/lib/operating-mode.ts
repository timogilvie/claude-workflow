import type { ModelClass } from './model-registry.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import type { QuotaSnapshot, QuotaStatus } from './quota-state.ts';
import { readQuotaSnapshot } from './quota-state.ts';

export type OperatingMode = 'normal' | 'constrained' | 'survival';

export const PREMIUM_MODEL_CLASS: ModelClass = 'frontier';
export const CONSTRAINED_TRIGGER_STATUS: QuotaStatus = 'degrading';
export const SURVIVAL_TRIGGER_STATUS: QuotaStatus = 'exhausted';

export function deriveOperatingMode(
  snapshot: QuotaSnapshot,
  premiumModelIds: ReadonlySet<string> | readonly string[],
): OperatingMode {
  const premiumIds = premiumModelIds instanceof Set
    ? premiumModelIds
    : new Set(premiumModelIds);

  let mode: OperatingMode = 'normal';

  for (const [modelId, entry] of Object.entries(snapshot.models)) {
    if (!premiumIds.has(modelId)) {
      continue;
    }

    if (entry.status === SURVIVAL_TRIGGER_STATUS) {
      return 'survival';
    }

    if (entry.status === CONSTRAINED_TRIGGER_STATUS) {
      mode = 'constrained';
    }
  }

  return mode;
}

export function getCurrentOperatingMode(repoDir?: string): OperatingMode {
  const snapshot = readQuotaSnapshot(repoDir);
  const registry = getEffectiveRegistry(repoDir);
  const premiumModelIds = Object.entries(registry.models)
    .filter(([, capabilities]) => capabilities.class === PREMIUM_MODEL_CLASS)
    .map(([modelId]) => modelId);

  return deriveOperatingMode(snapshot, premiumModelIds);
}

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

  if (premiumIds.size === 0) {
    return 'normal';
  }

  let anyHealthy = false;
  let allExhausted = true;

  for (const modelId of premiumIds) {
    const status = snapshot.models[modelId]?.status ?? 'healthy';

    if (status === 'healthy') {
      anyHealthy = true;
      allExhausted = false;
      continue;
    }

    if (status === CONSTRAINED_TRIGGER_STATUS) {
      allExhausted = false;
    }
  }

  if (anyHealthy) {
    return 'normal';
  }

  if (allExhausted) {
    return 'survival';
  }

  return 'constrained';
}

export function getCurrentOperatingMode(repoDir?: string): OperatingMode {
  const snapshot = readQuotaSnapshot(repoDir);
  const registry = getEffectiveRegistry(repoDir);
  const premiumModelIds = Object.entries(registry.models)
    .filter(([, capabilities]) => capabilities.class === PREMIUM_MODEL_CLASS)
    .map(([modelId]) => modelId);

  return deriveOperatingMode(snapshot, premiumModelIds);
}

export function hasAnyHealthyModel(repoDir?: string): boolean {
  const snapshot = readQuotaSnapshot(repoDir);
  const registry = getEffectiveRegistry(repoDir);

  for (const modelId of Object.keys(registry.models)) {
    const entry = snapshot.models[modelId];
    if (!entry || entry.status === 'healthy') {
      return true;
    }
  }

  return false;
}

export function getModelOperatingMode(modelId: string, repoDir?: string): OperatingMode {
  const snapshot = readQuotaSnapshot(repoDir);
  const entry = snapshot.models[modelId];

  if (!entry) {
    return 'normal';
  }

  if (entry.status === SURVIVAL_TRIGGER_STATUS) {
    return 'survival';
  }

  if (entry.status === CONSTRAINED_TRIGGER_STATUS) {
    return 'constrained';
  }

  return 'normal';
}

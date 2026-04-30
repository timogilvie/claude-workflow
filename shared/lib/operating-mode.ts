import type { ModelClass } from './model-registry.ts';
import { filterDeepSeekModels } from './deepseek-provider.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import type { QuotaSnapshot, QuotaStatus, VendorQuotaStats } from './quota-state.ts';
import { getVendorQuotaBreakdown, readQuotaSnapshot } from './quota-state.ts';

export type OperatingMode = 'normal' | 'constrained' | 'survival';

export interface OperatingModeResult {
  mode: OperatingMode;
  vendorBreakdown: Record<string, VendorQuotaStats>;
}

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
  return getOperatingModeResult(repoDir).mode;
}

export function getOperatingModeResult(repoDir?: string): OperatingModeResult {
  const snapshot = readQuotaSnapshot(repoDir);
  const registry = getEffectiveRegistry(repoDir);
  const unfilteredFrontierModels = Object.entries(registry.models)
    .filter(([, capabilities]) => capabilities.class === PREMIUM_MODEL_CLASS)
    .map(([modelId, capabilities]) => ({ modelId, vendor: capabilities.vendor }));
  const allowedModelIds = new Set(filterDeepSeekModels(
    unfilteredFrontierModels.map(({ modelId }) => modelId),
    repoDir,
  ).models);
  const frontierModels = unfilteredFrontierModels.filter(({ modelId }) => allowedModelIds.has(modelId));
  const premiumModelIds = frontierModels.map(({ modelId }) => modelId);

  return {
    mode: deriveOperatingMode(snapshot, premiumModelIds),
    vendorBreakdown: getVendorQuotaBreakdown(snapshot, frontierModels),
  };
}

export function hasAnyHealthyModel(repoDir?: string): boolean {
  const snapshot = readQuotaSnapshot(repoDir);
  const registry = getEffectiveRegistry(repoDir);
  const allowedModels = new Set(filterDeepSeekModels(Object.keys(registry.models), repoDir).models);

  for (const modelId of Object.keys(registry.models)) {
    if (!allowedModels.has(modelId)) {
      continue;
    }
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

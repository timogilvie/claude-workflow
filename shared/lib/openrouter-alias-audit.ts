import {
  DEFAULT_MODEL_REGISTRY,
  explainModelSupportExclusion,
  type ModelLifecycleStatus,
  type ModelRegistry,
} from './model-registry.ts';
import type { OpenRouterModel } from './openrouter-catalog.ts';
import { resolveOpenRouterModelId } from './openrouter-provider.ts';

export type AliasAuditReason =
  | 'unresolved-openrouter-id'
  | 'not-found-in-openrouter'
  | 'provider-native-id-mismatch';

export interface AliasAuditFinding {
  alias: string;
  providerNativeId: string | null;
  wireModelId: string | null;
  reason: AliasAuditReason;
  lifecycle: ModelLifecycleStatus;
  selectable: boolean;
  detail: string;
}

export interface AliasAuditReport {
  schemaVersion: '1';
  generatedAt: string;
  catalogSource: 'live' | 'file' | 'fixture';
  checked: number;
  findings: AliasAuditFinding[];
  selectableFindings: number;
}

export function auditOpenRouterAliases(input: {
  registry?: ModelRegistry;
  openRouterModels: ReadonlyMap<string, OpenRouterModel>;
  now?: Date;
  catalogSource: AliasAuditReport['catalogSource'];
}): AliasAuditReport {
  const registry = input.registry ?? DEFAULT_MODEL_REGISTRY;
  const findings: AliasAuditFinding[] = [];
  const aliases = Object.entries(registry.models)
    .filter(([, capabilities]) => capabilities.agent === 'native-openrouter')
    .map(([alias]) => alias)
    .sort();

  for (const alias of aliases) {
    const capabilities = registry.models[alias];
    const lifecycle = capabilities.supportedModel?.lifecycle ?? 'supported';
    const selectable = explainModelSupportExclusion(alias, 'coding', registry) === undefined;
    const providerNativeId = capabilities.supportedModel?.providerNativeId ?? null;
    const wireModelId = resolveOpenRouterModelId(alias);

    if (!wireModelId) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId: null,
        reason: 'unresolved-openrouter-id',
        lifecycle,
        selectable,
        detail: `${alias} does not resolve to a native OpenRouter wire model id.`,
      });
      continue;
    }

    if (!input.openRouterModels.has(wireModelId)) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'not-found-in-openrouter',
        lifecycle,
        selectable,
        detail: `${wireModelId} is absent from the OpenRouter catalog.`,
      });
      continue;
    }

    if (providerNativeId && providerNativeId !== wireModelId) {
      findings.push({
        alias,
        providerNativeId,
        wireModelId,
        reason: 'provider-native-id-mismatch',
        lifecycle,
        selectable,
        detail: `Registry providerNativeId ${providerNativeId} does not match resolved wire id ${wireModelId}.`,
      });
    }
  }

  return {
    schemaVersion: '1',
    generatedAt: (input.now ?? new Date()).toISOString(),
    catalogSource: input.catalogSource,
    checked: aliases.length,
    findings,
    selectableFindings: findings.filter((finding) => finding.selectable).length,
  };
}

export function hasSelectableAliasFindings(report: AliasAuditReport): boolean {
  return report.selectableFindings > 0;
}

/**
 * OpenRouter Alias Audit
 *
 * Cross-checks native-openrouter registry entries against their OpenRouter
 * wire identity and (optionally) the live catalog. Pure functions keep the
 * module unit-testable with a canned catalog `Map`; the thin CLI in
 * `tools/audit-openrouter-aliases.ts` handles network/file IO.
 *
 * Findings (HOK-2773):
 * - `unresolvable-alias`        registry says native-openrouter but no wire id
 *                              resolves (alias would be sent on the wire -> 400)
 * - `provider-id-mismatch`      registry providerNativeId != fixture openrouterId
 * - `missing-from-catalog`      wire id not in the live catalog
 * - `no-tool-support`           catalog advertises no `tools`; registry toolSupport !== 'none'
 * - `context-window-overstated` registry contextWindowTokens > catalog context_length
 *
 * Exit-1 policy: only a *selectable* finding fails the audit. Retired/blocked
 * models are reported for completeness but do not fail CI.
 *
 * @module openrouter-alias-audit
 */

import { listEffectiveModelsForStage } from './effective-models.ts';
import {
  DEFAULT_MODEL_REGISTRY,
  getModel,
  type AgentType,
  type ModelLifecycleStatus,
  type ModelRegistry,
  type SupportedModelStage,
} from './model-registry.ts';
import {
  resolveOpenRouterModelIdentity,
  openRouterModelSupportsTools,
  type OpenRouterModel,
} from './openrouter-catalog.ts';
import { resolveOpenRouterModelId } from './openrouter-provider.ts';

export type AliasAuditReason =
  | 'unresolvable-alias'
  | 'provider-id-mismatch'
  | 'missing-from-catalog'
  | 'no-tool-support'
  | 'context-window-overstated';

export interface AliasAuditFinding {
  modelId: string;
  wireId: string | null;
  reason: AliasAuditReason;
  detail: string;
  /** Model is still offered by at least one effective stage pool (planning/coding/review). */
  selectable: boolean;
  lifecycle: ModelLifecycleStatus;
}

export interface AliasAuditReport {
  auditedAt: string;
  /** Number of models in the live catalog, or null when running offline. */
  catalogSize: number | null;
  /** Every registry model with `agent === 'native-openrouter'`. */
  auditedModels: string[];
  findings: AliasAuditFinding[];
  selectableFindingCount: number;
}

const AUDITED_STAGES: readonly SupportedModelStage[] = ['planning', 'coding', 'review'];

/**
 * List every model id in the registry whose `agent` is `native-openrouter`.
 * Sorted by id for deterministic output.
 */
export function listNativeOpenRouterRegistryModels(registry: ModelRegistry = DEFAULT_MODEL_REGISTRY): string[] {
  return Object.entries(registry.models)
    .filter(([, capabilities]) => capabilities.agent === 'native-openrouter')
    .map(([modelId]) => modelId)
    .sort((a, b) => a.localeCompare(b));
}

function resolveLifecycle(capabilities: ReturnType<typeof getModel>): ModelLifecycleStatus {
  return capabilities?.supportedModel?.lifecycle ?? 'supported';
}

function isModelSelectable(modelId: string, registry: ModelRegistry): boolean {
  for (const stage of AUDITED_STAGES) {
    if (listEffectiveModelsForStage(stage, { registry }).models.includes(modelId)) {
      return true;
    }
  }
  return false;
}

function sortFindings(findings: AliasAuditFinding[]): AliasAuditFinding[] {
  return [...findings].sort((a, b) => {
    if (a.selectable !== b.selectable) {
      return a.selectable ? -1 : 1;
    }
    return a.modelId.localeCompare(b.modelId);
  });
}

/**
 * Offline checks: resolve each native-openrouter registry alias to its wire id
 * and verify the registry `providerNativeId` matches the fixture identity. No
 * network is required; these run on every PR.
 */
export function auditRegistryAliasResolution(registry: ModelRegistry = DEFAULT_MODEL_REGISTRY): AliasAuditFinding[] {
  const findings: AliasAuditFinding[] = [];

  for (const modelId of listNativeOpenRouterRegistryModels(registry)) {
    const capabilities = getModel(registry, modelId);
    if (!capabilities) {
      continue;
    }
    const lifecycle = resolveLifecycle(capabilities);
    const selectable = isModelSelectable(modelId, registry);

    const identity = resolveOpenRouterModelIdentity(modelId);
    const wireId = resolveOpenRouterModelId(modelId);
    const registryProviderNativeId = capabilities.supportedModel?.providerNativeId ?? null;

    if (wireId === null) {
      const detailParts = [
        `Registry declares agent=native-openrouter with providerNativeId=${registryProviderNativeId ?? 'none'},`,
        'but resolveOpenRouterModelId() returns null',
      ];
      if (identity && identity.nativeOpenRouter === false) {
        detailParts.push(`(fixture identity nativeOpenRouter=false; isNativeOpenRouterProviderId excludes ${identity.openrouterId})`);
      } else if (!identity) {
        detailParts.push('(no launch-priority fixture identity found for the alias)');
      } else {
        detailParts.push(`(fixture openrouterId=${identity.openrouterId})`);
      }
      detailParts.push('so the raw alias would be sent on the wire and rejected by OpenRouter.');
      findings.push({
        modelId,
        wireId: null,
        reason: 'unresolvable-alias',
        detail: detailParts.join(' '),
        selectable,
        lifecycle,
      });
      continue;
    }

    if (identity && registryProviderNativeId && identity.openrouterId !== registryProviderNativeId) {
      findings.push({
        modelId,
        wireId,
        reason: 'provider-id-mismatch',
        detail: `Registry supportedModel.providerNativeId="${registryProviderNativeId}" differs from fixture openrouterId="${identity.openrouterId}".`,
        selectable,
        lifecycle,
      });
    }
  }

  return sortFindings(findings);
}

/**
 * Full audit: offline alias-resolution checks plus live catalog cross-checks.
 * Pass a canned `Map<string, OpenRouterModel>` for deterministic unit tests.
 */
export function auditRegistryAgainstCatalog(
  catalog: Map<string, OpenRouterModel>,
  registry: ModelRegistry = DEFAULT_MODEL_REGISTRY,
  opts: { now?: Date } = {},
): AliasAuditReport {
  const auditedAt = (opts.now ?? new Date()).toISOString();
  const auditedModels = listNativeOpenRouterRegistryModels(registry);
  const offlineFindings = auditRegistryAliasResolution(registry);
  // Index offline findings by modelId so a model flagged offline does not also
  // get re-checked against the catalog (it has no wire id to look up).
  const offlineFlagged = new Set(offlineFindings.map((f) => f.modelId));
  const findings: AliasAuditFinding[] = [...offlineFindings];

  for (const modelId of auditedModels) {
    if (offlineFlagged.has(modelId)) {
      continue;
    }
    const capabilities = getModel(registry, modelId);
    if (!capabilities) {
      continue;
    }
    const lifecycle = resolveLifecycle(capabilities);
    const selectable = isModelSelectable(modelId, registry);
    const wireId = resolveOpenRouterModelId(modelId);
    if (wireId === null) {
      // Already covered by offline pass; skip defensively.
      continue;
    }

    const catalogModel = catalog.get(wireId);
    if (!catalogModel) {
      findings.push({
        modelId,
        wireId,
        reason: 'missing-from-catalog',
        detail: `Wire id "${wireId}" is not present in the live OpenRouter catalog.`,
        selectable,
        lifecycle,
      });
      continue;
    }

    if (capabilities.toolSupport !== 'none') {
      const supportsTools = openRouterModelSupportsTools(catalogModel);
      if (supportsTools === false) {
        findings.push({
          modelId,
          wireId,
          reason: 'no-tool-support',
          detail: `Catalog "${wireId}" does not advertise "tools" in supported_parameters, but registry toolSupport="${capabilities.toolSupport}". Launches would fail with "404 No endpoints found that support tool use".`,
          selectable,
          lifecycle,
        });
      }
    }

    const catalogContext = catalogModel.context_length ?? catalogModel.top_provider?.context_length;
    if (typeof catalogContext === 'number' && Number.isFinite(catalogContext) && capabilities.contextWindowTokens > catalogContext) {
      findings.push({
        modelId,
        wireId,
        reason: 'context-window-overstated',
        detail: `Registry contextWindowTokens=${capabilities.contextWindowTokens} exceeds catalog context_length=${catalogContext} for "${wireId}"; prompts the provider rejects can slip through pre-flight.`,
        selectable,
        lifecycle,
      });
    }
  }

  const sorted = sortFindings(findings);
  const selectableFindingCount = sorted.filter((f) => f.selectable).length;

  return {
    auditedAt,
    catalogSize: catalog.size,
    auditedModels,
    findings: sorted,
    selectableFindingCount,
  };
}

/**
 * Human-readable rendering of an {@link AliasAuditReport}. One line per
 * finding plus a summary header and a clean-report footer.
 */
export function renderAliasAuditReport(report: AliasAuditReport): string {
  const lines: string[] = [];
  lines.push(`OpenRouter alias audit (audited ${report.auditedModels.length} native-openrouter models; catalog=${report.catalogSize ?? 'offline'})`);
  lines.push(`selectable findings: ${report.selectableFindingCount} (exit 1 when > 0)`);

  if (report.findings.length === 0) {
    lines.push('no findings: every native-openrouter alias resolves, is present in the catalog, supports tools, and does not overstate its context window.');
    return lines.join('\n');
  }

  for (const finding of report.findings) {
    const flag = finding.selectable ? '[SELECTABLE]' : `[${finding.lifecycle}]`;
    lines.push(`- ${finding.modelId} ${flag} ${finding.reason} (wireId=${finding.wireId ?? 'null'})`);
    lines.push(`    ${finding.detail}`);
  }

  return lines.join('\n');
}

/** Re-exported for callers that want the agent type without importing model-registry directly. */
export type { AgentType };


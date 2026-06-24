import {
  getEffectiveRegistry,
  isReadOnlyNativeCapable,
  type ModelRegistry,
  type ReadOnlyNativeCapability,
} from '../model-registry.ts';
import type { ReadyNativeProviderEntry, ResolvedNativeProviderEntry } from './providers.ts';

export const READ_ONLY_NATIVE_PHASES = ['expansion', 'planning', 'read-only-review'] as const;
export type NativeRoutingPhase = (typeof READ_ONLY_NATIVE_PHASES)[number];

export type NativeRoutingPurpose = 'task' | 'certification';

export interface NativeRoutingRefusal {
  modelId: string;
  provider?: string;
  phase: NativeRoutingPhase;
  requiredCertification: 'certified';
  actualCapability: ReadOnlyNativeCapability | 'unregistered';
  message: string;
}

export type NativeRoutingDecision =
  | { routable: true; modelId: string }
  | { routable: false; evaluable: boolean; refusal: NativeRoutingRefusal };

export interface CertifyReadOnlyNativeRoutingOptions {
  phase: NativeRoutingPhase;
  purpose: NativeRoutingPurpose;
  registry?: ModelRegistry;
  provider?: string;
  allowPartial?: boolean;
}

/**
 * Gate for native model selection during ordinary task execution.
 *
 * `purpose: 'task'` — routable only when the model is certified (or partial + allowPartial).
 * `purpose: 'certification'` — never routable; evaluable for certification/smoke runs only.
 * No silent fallback: uncertified models produce a refusal that names model, phase, and missing
 * certification.
 */
export function certifyReadOnlyNativeRouting(
  modelId: string,
  opts: CertifyReadOnlyNativeRoutingOptions,
): NativeRoutingDecision {
  const { phase, purpose, registry: registryOpt, provider, allowPartial } = opts;
  const registry = registryOpt ?? getEffectiveRegistry();

  if (purpose === 'certification') {
    return {
      routable: false,
      evaluable: true,
      refusal: buildRefusal(modelId, phase, provider, registry),
    };
  }

  if (isReadOnlyNativeCapable(modelId, { registry, allowPartial })) {
    return { routable: true, modelId };
  }

  return {
    routable: false,
    evaluable: false,
    refusal: buildRefusal(modelId, phase, provider, registry),
  };
}

function buildRefusal(
  modelId: string,
  phase: NativeRoutingPhase,
  provider: string | undefined,
  registry: ModelRegistry,
): NativeRoutingRefusal {
  const nativeCapability = registry.models[modelId]?.nativeCapability;
  const actualCapability: ReadOnlyNativeCapability | 'unregistered' = nativeCapability
    ? nativeCapability.readOnlyNative
    : 'unregistered';

  let message: string;
  if (actualCapability === 'unregistered') {
    message =
      `Model "${modelId}" cannot be used for native routing in phase "${phase}": ` +
      `it is not registered in the capability registry with native read-only metadata. ` +
      `Register and certify the model (nativeCapability.readOnlyNative = "certified") ` +
      `before routing tasks to it.`;
  } else if (actualCapability === 'unsupported') {
    message =
      `Model "${modelId}" cannot be used for native routing in phase "${phase}": ` +
      `its read-only native capability is "unsupported". ` +
      `Only "certified" models may be routed to for ordinary task execution.`;
  } else {
    // partial
    message =
      `Model "${modelId}" cannot be used for native routing in phase "${phase}": ` +
      `its read-only native capability is "partial" and allowPartial is not enabled. ` +
      `Set allowPartial: true or promote the model to "certified" before routing tasks to it.`;
  }

  return {
    modelId,
    ...(provider !== undefined ? { provider } : {}),
    phase,
    requiredCertification: 'certified',
    actualCapability,
    message,
  };
}

export interface PartitionNativeProvidersByCertificationOptions {
  phase: NativeRoutingPhase;
  registry?: ModelRegistry;
  allowPartial?: boolean;
}

export interface NativeProviderPartition {
  routable: ReadyNativeProviderEntry[];
  refused: NativeRoutingRefusal[];
}

/**
 * Split a resolved provider list into certified-routable entries and refusals.
 *
 * Only `ready` entries are evaluated; `unavailable` and `skipped` entries are excluded.
 * Caller is responsible for surfacing `refused` reasons — this function never auto-selects
 * an alternative or silently drops a refusal.
 */
export function partitionNativeProvidersByCertification(
  entries: readonly ResolvedNativeProviderEntry[],
  opts: PartitionNativeProvidersByCertificationOptions,
): NativeProviderPartition {
  const { phase, registry, allowPartial } = opts;
  const routable: ReadyNativeProviderEntry[] = [];
  const refused: NativeRoutingRefusal[] = [];

  for (const entry of entries) {
    if (entry.status !== 'ready') {
      continue;
    }

    const decision = certifyReadOnlyNativeRouting(entry.modelId, {
      phase,
      purpose: 'task',
      registry,
      provider: entry.providerName,
      allowPartial,
    });

    if (decision.routable) {
      routable.push(entry);
    } else {
      refused.push(decision.refusal);
    }
  }

  return { routable, refused };
}

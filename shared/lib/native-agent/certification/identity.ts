import { resolveOpenRouterModelIdentity } from '../../openrouter-catalog.ts';

export interface CertificationStorageIdentity {
  provider: string;
  model: string;
}

const UNSAFE_SEGMENT = /[/\\\0]/;
const PROVIDER_ALIASES = new Map<string, string>([
  ['qwen', 'qwen'],
  ['alibaba', 'qwen'],
  ['alibaba-cloud', 'qwen'],
  ['zai', 'z-ai'],
  ['z-ai', 'z-ai'],
  ['z.ai', 'z-ai'],
  ['glm', 'z-ai'],
  ['moonshot', 'moonshotai'],
  ['moonshot-ai', 'moonshotai'],
  ['moonshotai', 'moonshotai'],
]);

export function isValidCertificationPathSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (UNSAFE_SEGMENT.test(segment)) return false;
  return true;
}

export function resolveCertificationStorageIdentity(
  provider: string,
  model: string,
): CertificationStorageIdentity {
  const normalizedProvider = normalizeStorageSegment(provider);
  const normalizedModel = normalizeStorageSegment(model);

  if (normalizedProvider !== 'openrouter') {
    return {
      provider: canonicalProviderSegment(normalizedProvider),
      model: normalizedModel,
    };
  }

  const openrouterModelId = resolveOpenRouterModelIdentity(model)?.openrouterId ?? normalizedModel;

  const parts = openrouterModelId.toLowerCase().split('/');
  if (
    parts.length === 2
    && isValidCertificationPathSegment(parts[0]!)
    && isValidCertificationPathSegment(parts[1]!)
  ) {
    return {
      provider: canonicalProviderSegment(parts[0]!),
      model: parts[1]!,
    };
  }

  return { provider: normalizedProvider, model: normalizedModel };
}

function normalizeStorageSegment(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalProviderSegment(provider: string): string {
  return PROVIDER_ALIASES.get(provider) ?? provider;
}

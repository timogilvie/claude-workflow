import { resolveOpenRouterIdFromWavemillAlias } from '../../openrouter-catalog.ts';

export interface CertificationStorageIdentity {
  provider: string;
  model: string;
}

const UNSAFE_SEGMENT = /[/\\\0]/;

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
  if (provider !== 'openrouter') {
    return { provider, model };
  }

  const openrouterModelId = model.includes('/')
    ? model
    : resolveOpenRouterIdFromWavemillAlias(model) ?? model;

  const parts = openrouterModelId.split('/');
  if (
    parts.length === 2
    && isValidCertificationPathSegment(parts[0]!)
    && isValidCertificationPathSegment(parts[1]!)
  ) {
    return {
      provider: parts[0]!,
      model: parts[1]!,
    };
  }

  return { provider, model };
}

import { join, resolve } from 'node:path';
import { CERTIFICATION_BASE_PATH } from './schema.ts';
import {
  isValidCertificationPathSegment,
  resolveCertificationStorageIdentity,
} from './identity.ts';

export type CertificationStorageScope = 'global' | 'legacy-local';

export interface CertificationPathOptions {
  scope?: CertificationStorageScope;
}

export function resolveWavemillRepoRoot(): string {
  return resolve(new URL('../../../../', import.meta.url).pathname);
}

export function resolveSharedCertificationRoot(): string {
  const configured = process.env.WAVEMILL_CERTIFICATION_ROOT?.trim();
  if (configured) {
    return resolve(configured);
  }
  return join(resolveWavemillRepoRoot(), CERTIFICATION_BASE_PATH);
}

export function resolveLegacyCertificationRoot(repoDir: string): string {
  return join(repoDir, CERTIFICATION_BASE_PATH);
}

export function resolveCertificationRoot(
  repoDir: string,
  options: CertificationPathOptions = {},
): string {
  return options.scope === 'legacy-local'
    ? resolveLegacyCertificationRoot(repoDir)
    : resolveSharedCertificationRoot();
}

export function buildCertificationArtifactPath(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  options: CertificationPathOptions = {},
): string {
  const identity = resolveCertificationStorageIdentity(provider, model);

  for (const [name, value] of [
    ['provider', identity.provider],
    ['model', identity.model],
    ['suiteVersion', suiteVersion],
  ] as const) {
    if (!isValidCertificationPathSegment(value)) {
      throw new Error(`Invalid certification path segment for ${name}: ${JSON.stringify(value)}`);
    }
  }

  return join(resolveCertificationRoot(repoDir, options), identity.provider, identity.model, `${suiteVersion}.json`);
}

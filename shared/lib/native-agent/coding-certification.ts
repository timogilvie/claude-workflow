import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeAgentProviderName } from '../config.ts';

export const PATCH_CODING_CERTIFICATION_SCHEMA_VERSION = 1 as const;
export const PATCH_CODING_CERTIFICATION_RELATIVE_PATH = '.wavemill/native-agent/patch-coding-certification.json';

export type PatchCodingCertificationReason =
  | 'missing'
  | 'malformed'
  | 'not_certified'
  | 'missing_revision'
  | 'revision_mismatch'
  | 'insufficient_providers'
  | 'provider_failed';

export interface PatchCodingProviderResult {
  provider: NativeAgentProviderName | string;
  model: string;
  passed: boolean;
  transcriptPath?: string;
  skipReason?: string;
}

export interface PatchCodingCertification {
  schemaVersion: typeof PATCH_CODING_CERTIFICATION_SCHEMA_VERSION;
  certified: boolean;
  smokeSuiteRevision: string;
  providers: PatchCodingProviderResult[];
  certifiedAt: string;
}

export type PatchCodingCertificationStatus =
  | { valid: true; record: PatchCodingCertification }
  | { valid: false; reason: PatchCodingCertificationReason; record?: PatchCodingCertification };

export function getPatchCodingCertificationPath(repoDir: string): string {
  return join(repoDir, PATCH_CODING_CERTIFICATION_RELATIVE_PATH);
}

export function validatePatchCodingCertification(
  input: unknown,
  currentSmokeSuiteRevision: string,
): PatchCodingCertificationStatus {
  const record = parseCertificationRecord(input);
  if (!record) {
    return { valid: false, reason: 'malformed' };
  }

  if (record.certified !== true) {
    return { valid: false, reason: 'not_certified', record };
  }

  if (record.smokeSuiteRevision.trim().length === 0) {
    return { valid: false, reason: 'missing_revision', record };
  }

  if (record.smokeSuiteRevision !== currentSmokeSuiteRevision) {
    return { valid: false, reason: 'revision_mismatch', record };
  }

  const distinctPairs = new Set<string>();
  for (const providerResult of record.providers) {
    const provider = providerResult.provider.trim();
    const model = providerResult.model.trim();
    if (provider.length === 0 || model.length === 0) {
      return { valid: false, reason: 'malformed', record };
    }
    if (providerResult.passed !== true) {
      return { valid: false, reason: 'provider_failed', record };
    }
    distinctPairs.add(`${provider}::${model}`);
  }

  if (distinctPairs.size < 2) {
    return { valid: false, reason: 'insufficient_providers', record };
  }

  return { valid: true, record };
}

export function loadPatchCodingCertification(
  repoDir: string,
  currentSmokeSuiteRevision: string,
): PatchCodingCertificationStatus {
  const path = getPatchCodingCertificationPath(repoDir);
  if (!existsSync(path)) {
    return { valid: false, reason: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  return validatePatchCodingCertification(parsed, currentSmokeSuiteRevision);
}

export function writePatchCodingCertification(
  repoDir: string,
  record: PatchCodingCertification,
): string {
  const certificationPath = getPatchCodingCertificationPath(repoDir);
  mkdirSync(dirname(certificationPath), { recursive: true });

  const tmpPath = `${certificationPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, certificationPath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return certificationPath;
}

function parseCertificationRecord(input: unknown): PatchCodingCertification | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  if (
    candidate.schemaVersion !== PATCH_CODING_CERTIFICATION_SCHEMA_VERSION
    || typeof candidate.certified !== 'boolean'
    || typeof candidate.smokeSuiteRevision !== 'string'
    || typeof candidate.certifiedAt !== 'string'
    || !Array.isArray(candidate.providers)
  ) {
    return undefined;
  }

  const providers: PatchCodingProviderResult[] = [];
  for (const entry of candidate.providers) {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }
    const providerCandidate = entry as Record<string, unknown>;
    if (
      typeof providerCandidate.provider !== 'string'
      || typeof providerCandidate.model !== 'string'
      || typeof providerCandidate.passed !== 'boolean'
    ) {
      return undefined;
    }

    const providerResult: PatchCodingProviderResult = {
      provider: providerCandidate.provider,
      model: providerCandidate.model,
      passed: providerCandidate.passed,
    };

    if (providerCandidate.transcriptPath !== undefined) {
      if (typeof providerCandidate.transcriptPath !== 'string') {
        return undefined;
      }
      providerResult.transcriptPath = providerCandidate.transcriptPath;
    }

    if (providerCandidate.skipReason !== undefined) {
      if (typeof providerCandidate.skipReason !== 'string') {
        return undefined;
      }
      providerResult.skipReason = providerCandidate.skipReason;
    }

    providers.push(providerResult);
  }

  return {
    schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
    certified: candidate.certified,
    smokeSuiteRevision: candidate.smokeSuiteRevision,
    providers,
    certifiedAt: candidate.certifiedAt,
  };
}

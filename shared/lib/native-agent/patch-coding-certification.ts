import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface PatchCodingProviderRun {
  provider: string;
  model: string;
  usageTokens: number;
  toolCalls: number;
}

export interface PatchCodingCertification {
  schemaVersion: '1';
  smokeSuiteRevision: string;
  certifiedAt: string;
  providers: PatchCodingProviderRun[];
}

export type CertificationCoverageResult =
  | { ok: true }
  | { ok: false; reason: string };

export function computeSmokeSuiteRevision(filePaths: string[]): string {
  const hash = createHash('sha256');
  for (const filePath of [...filePaths].sort()) {
    hash.update(readFileSync(filePath, 'utf-8'));
  }
  return hash.digest('hex');
}

function isProviderRun(value: unknown): value is PatchCodingProviderRun {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as PatchCodingProviderRun).provider === 'string'
    && typeof (value as PatchCodingProviderRun).model === 'string'
    && typeof (value as PatchCodingProviderRun).usageTokens === 'number'
    && Number.isFinite((value as PatchCodingProviderRun).usageTokens)
    && typeof (value as PatchCodingProviderRun).toolCalls === 'number'
    && Number.isFinite((value as PatchCodingProviderRun).toolCalls)
  );
}

export function readPatchCodingCertification(
  certPath: string,
): PatchCodingCertification | null {
  try {
    if (!existsSync(certPath)) {
      return null;
    }

    const parsed = JSON.parse(readFileSync(certPath, 'utf-8')) as Partial<PatchCodingCertification>;
    if (
      parsed.schemaVersion !== '1'
      || typeof parsed.smokeSuiteRevision !== 'string'
      || typeof parsed.certifiedAt !== 'string'
      || !Array.isArray(parsed.providers)
      || !parsed.providers.every((provider) => isProviderRun(provider))
    ) {
      return null;
    }

    return {
      schemaVersion: '1',
      smokeSuiteRevision: parsed.smokeSuiteRevision,
      certifiedAt: parsed.certifiedAt,
      providers: parsed.providers,
    };
  } catch {
    return null;
  }
}

export function assertPatchCodingCertificationCoverage(
  record: PatchCodingCertification,
): CertificationCoverageResult {
  if (record.providers.length < 2) {
    return {
      ok: false,
      reason: `requires ≥2 distinct providers/models, found ${record.providers.length}`,
    };
  }

  const seen = new Set<string>();
  for (const run of record.providers) {
    const key = `${run.provider}::${run.model}`;
    if (seen.has(key)) {
      return {
        ok: false,
        reason: `duplicate (provider, model) pair: "${run.provider}/${run.model}"`,
      };
    }
    seen.add(key);
  }

  for (const run of record.providers) {
    if (run.usageTokens <= 0) {
      return {
        ok: false,
        reason: `entry "${run.provider}/${run.model}" has zero usage tokens`,
      };
    }
    if (run.toolCalls < 1) {
      return {
        ok: false,
        reason: `entry "${run.provider}/${run.model}" has no tool calls`,
      };
    }
  }

  return { ok: true };
}

export function summarizeCertification(record: PatchCodingCertification): string {
  const lines = [
    'Patch Coding Alpha Certification',
    `  Certified at:    ${record.certifiedAt}`,
    `  Suite revision:  ${record.smokeSuiteRevision}`,
    `  Providers (${record.providers.length}):`,
  ];

  for (const provider of record.providers) {
    lines.push(
      `    - ${provider.provider}/${provider.model}: ${provider.usageTokens} tokens, ${provider.toolCalls} tool calls`,
    );
  }

  return lines.join('\n');
}

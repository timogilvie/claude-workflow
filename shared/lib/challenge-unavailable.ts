import { loadWavemillConfig } from './config.ts';
import type { NativeProviderName } from './model-registry.ts';
import type { ModelExclusionDiagnostic } from './model-exclusions.ts';
import { scanForbiddenModelSettings } from './model-settings-migrator.ts';
import type { ChallengeNativeRejection } from './challenge-mode.ts';

export type ChallengeUnavailableBlocker =
  | { kind: 'insufficient_certified_pool'; certifiedCount: number; minimum: 2 }
  | { kind: 'primary_uncertifiable'; modelId: string; reason: string; apiKeyEnv?: string }
  | { kind: 'no_certified_challenger_for_primary'; primaryModel: string; poolConsidered: string[] }
  | { kind: 'runtime_blocker'; provider?: NativeProviderName; reason: 'missing_api_key' | 'provider_outage'; apiKeyEnv?: string }
  | { kind: 'forbidden_local_config'; consumerRepo: string; field: string };

export interface ChallengeUnavailableCandidateDiagnostic {
  modelId: string;
  provider?: NativeProviderName;
  reason: string;
  apiKeyEnv?: string;
  artifactPath?: string;
}

export interface ChallengeUnavailableResult {
  mode: 'challenge_unavailable';
  requestedRate: number;
  globalCatalogVersion?: string;
  blockers: ChallengeUnavailableBlocker[];
  candidateDiagnostics: ChallengeUnavailableCandidateDiagnostic[];
  cleanupHint: 'no_worktree_created';
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function providerFromConfig(repoDir: string, provider?: string): { apiKeyEnv?: string } {
  if (!provider) return {};
  const providers = loadWavemillConfig(repoDir).providers as Record<string, { apiKeyEnv?: string } | undefined> | undefined;
  return { apiKeyEnv: providers?.[provider]?.apiKeyEnv };
}

function diagnosticsFromRejections(
  rejections: ChallengeNativeRejection[],
): ChallengeUnavailableCandidateDiagnostic[] {
  return rejections
    .map((rejection) => ({
      modelId: rejection.modelId,
      ...(rejection.nativeProvider ? { provider: rejection.nativeProvider } : {}),
      reason: rejection.reason,
      ...(rejection.apiKeyEnv ? { apiKeyEnv: rejection.apiKeyEnv } : {}),
      ...(rejection.artifactPath ? { artifactPath: rejection.artifactPath } : {}),
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId) || a.reason.localeCompare(b.reason));
}

export function buildChallengeUnavailable(opts: {
  requestedRate: number;
  pool: string[];
  certifiedPool?: string[];
  primaryModel?: string;
  repoDir: string;
  nativeCertificationRejections?: ChallengeNativeRejection[];
  modelExclusions?: ModelExclusionDiagnostic[];
}): ChallengeUnavailableResult {
  const pool = uniqueSorted(opts.pool);
  const certifiedPool = uniqueSorted(opts.certifiedPool ?? []);
  const rejections = opts.nativeCertificationRejections ?? [];
  const blockers: ChallengeUnavailableBlocker[] = [];
  const primaryModel = opts.primaryModel?.trim() || pool[0] || '';

  if (certifiedPool.length < 2) {
    blockers.push({
      kind: 'insufficient_certified_pool',
      certifiedCount: certifiedPool.length,
      minimum: 2,
    });
  }
  if (primaryModel && certifiedPool.filter((model) => model !== primaryModel).length === 0) {
    blockers.push({
      kind: 'no_certified_challenger_for_primary',
      primaryModel,
      poolConsidered: pool,
    });
  }

  for (const rejection of rejections) {
    if (primaryModel && rejection.modelId === primaryModel) {
      blockers.push({
        kind: 'primary_uncertifiable',
        modelId: rejection.modelId,
        reason: rejection.reason,
        ...(rejection.apiKeyEnv ? { apiKeyEnv: rejection.apiKeyEnv } : {}),
      });
    }
    if (rejection.reason === 'missing-api-key') {
      blockers.push({
        kind: 'runtime_blocker',
        ...(rejection.nativeProvider ? { provider: rejection.nativeProvider } : {}),
        reason: 'missing_api_key',
        ...(rejection.apiKeyEnv ?? providerFromConfig(opts.repoDir, rejection.nativeProvider).apiKeyEnv
          ? { apiKeyEnv: rejection.apiKeyEnv ?? providerFromConfig(opts.repoDir, rejection.nativeProvider).apiKeyEnv }
          : {}),
      });
    }
  }

  for (const item of scanForbiddenModelSettings(opts.repoDir)) {
    blockers.push({
      kind: 'forbidden_local_config',
      consumerRepo: item.file,
      field: item.path,
    });
  }

  const globalCatalogVersion = uniqueSorted(rejections.map((entry) => entry.requiredSuiteVersion))[0];
  const candidateDiagnostics = diagnosticsFromRejections(rejections);
  if (candidateDiagnostics.length === 0 && opts.modelExclusions?.length) {
    candidateDiagnostics.push(...opts.modelExclusions.map((exclusion) => ({
      modelId: exclusion.modelId,
      reason: `policy-excluded:${exclusion.source}`,
    })));
  }

  return {
    mode: 'challenge_unavailable',
    requestedRate: opts.requestedRate,
    ...(globalCatalogVersion ? { globalCatalogVersion } : {}),
    blockers: blockers.length > 0
      ? blockers
      : [{ kind: 'insufficient_certified_pool', certifiedCount: certifiedPool.length, minimum: 2 }],
    candidateDiagnostics,
    cleanupHint: 'no_worktree_created',
  };
}

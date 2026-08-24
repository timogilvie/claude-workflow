import { getEffectiveRegistry, type ModelRegistry } from '../../model-registry.ts';
import { resolveCertificationStorage } from './storage.ts';
import { listGlobalCertificationSuiteVersions } from './store.ts';

export type SuiteCoverageStatus = 'ok' | 'bump-without-publish' | 'empty-store';

export interface SuiteCoverageResult {
  requiredSuiteVersion: string;
  nativeModelCount: number;
  artifactCountForRequiredSuite: number;
  artifactCountByOtherSuite: Record<string, number>;
  status: SuiteCoverageStatus;
  remediationCommand: string;
  root: string;
}

export interface SuiteCoverageOptions {
  registry?: ModelRegistry;
  repoDir?: string;
  root?: string;
}

const REMEDIATION_COMMAND = 'wavemill native-agent certify --all --phase workflow';

export function evaluateSuiteCoverage(options: SuiteCoverageOptions = {}): SuiteCoverageResult {
  const registry = options.registry ?? getEffectiveRegistry(options.repoDir ?? process.cwd());
  const storage = resolveCertificationStorage({ scope: 'global', root: options.root });
  const requiredSuiteVersions = nativeCertificationSuiteVersions(registry);
  const requiredSuiteVersion = requiredSuiteVersions.join(',');
  const suiteCounts = listGlobalCertificationSuiteVersions({ root: options.root });
  const requiredSet = new Set(requiredSuiteVersions);
  const artifactCountForRequiredSuite = requiredSuiteVersions.reduce(
    (sum, suiteVersion) => sum + (suiteCounts[suiteVersion] ?? 0),
    0,
  );
  const artifactCountByOtherSuite: Record<string, number> = {};
  for (const [suiteVersion, count] of Object.entries(suiteCounts).sort(([a], [b]) => a.localeCompare(b))) {
    if (!requiredSet.has(suiteVersion)) {
      artifactCountByOtherSuite[suiteVersion] = count;
    }
  }

  const nativeModelCount = Object.values(registry.models).filter((model) => (
    Boolean(model.nativeCapability?.certification?.certificationSuiteVersion?.trim())
  )).length;
  const otherArtifactCount = Object.values(artifactCountByOtherSuite).reduce((sum, count) => sum + count, 0);
  const totalArtifactCount = artifactCountForRequiredSuite + otherArtifactCount;
  const status: SuiteCoverageStatus = artifactCountForRequiredSuite > 0
    ? 'ok'
    : totalArtifactCount === 0
      ? 'empty-store'
      : 'bump-without-publish';

  return {
    requiredSuiteVersion,
    nativeModelCount,
    artifactCountForRequiredSuite,
    artifactCountByOtherSuite,
    status,
    remediationCommand: REMEDIATION_COMMAND,
    root: storage.root,
  };
}

function nativeCertificationSuiteVersions(registry: ModelRegistry): string[] {
  return [...new Set(Object.values(registry.models)
    .map((model) => model.nativeCapability?.certification?.certificationSuiteVersion?.trim())
    .filter((suiteVersion): suiteVersion is string => Boolean(suiteVersion)))]
    .sort();
}

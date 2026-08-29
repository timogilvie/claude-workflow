import { getEffectiveRegistry, type ModelRegistry } from '../../model-registry.ts';
import { resolveCertificationStorage } from './storage.ts';
import { listGlobalCertificationSuiteVersions } from './store.ts';
import { resolveCertificationSubject } from './identity.ts';
import { checkGlobalCertificationEligibility, type IneligibilityReason } from './loader.ts';

export type SuiteCoverageStatus =
  | 'ok'
  | 'bump-without-publish'
  | 'empty-store'
  | 'identity-drift';

/** A native model whose stored artifact exists but does not grant eligibility. */
export interface IneligibleModel {
  registryKey: string;
  reason: IneligibilityReason;
}

export interface SuiteCoverageResult {
  requiredSuiteVersion: string;
  nativeModelCount: number;
  artifactCountForRequiredSuite: number;
  artifactCountByOtherSuite: Record<string, number>;
  status: SuiteCoverageStatus;
  remediationCommand: string;
  root: string;
  /**
   * Native models whose artifact is present at the required suite version but
   * still fails `evaluateEligibility` — overwhelmingly `identity-reidentified`
   * after the launch-priority fixture changed. Counting artifacts alone cannot
   * see this: the count and suite version are unchanged, only the subjects are
   * stale, so the guard reported `ok` through a total reviewer outage.
   */
  ineligibleModels: IneligibleModel[];
  eligibleModelCount: number;
  /** Subset of `ineligibleModels` rejected specifically for subject mismatch. */
  identityDriftCount: number;
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
  const { ineligibleModels, eligibleModelCount } = evaluateIdentityCoverage(
    registry,
    requiredSuiteVersions,
    options.root,
  );

  const identityDriftCount = ineligibleModels
    .filter((entry) => entry.reason === 'identity-reidentified').length;
  const certifiableCount = eligibleModelCount + ineligibleModels.length;

  let status: SuiteCoverageStatus;
  if (artifactCountForRequiredSuite === 0) {
    status = totalArtifactCount === 0 ? 'empty-store' : 'bump-without-publish';
  } else if (
    // Nothing left to launch with, or subject mismatch has taken out at least
    // half the certifiable fleet. `catalogHash` is shared by every OpenRouter
    // model, so real drift is always broad — a stale orphan or two (a model
    // dropped from the fixture but still on disk) must not raise the alarm.
    (eligibleModelCount === 0 && ineligibleModels.length > 0)
    || (identityDriftCount > 0 && identityDriftCount >= Math.ceil(certifiableCount / 2))
  ) {
    status = 'identity-drift';
  } else {
    status = 'ok';
  }

  return {
    ineligibleModels,
    eligibleModelCount,
    identityDriftCount,
    requiredSuiteVersion,
    nativeModelCount,
    artifactCountForRequiredSuite,
    artifactCountByOtherSuite,
    status,
    remediationCommand: REMEDIATION_COMMAND,
    root: storage.root,
  };
}

/**
 * Resolve each native model's expected subject and ask the same loader the
 * launch gate uses whether the stored artifact grants eligibility.
 *
 * Phase is checked at `read-only`, the lowest rung of PHASE_ORDER, so this
 * reports identity/version/staleness drift without flagging a model that is
 * merely certified below the phase a particular launch wants.
 */
function evaluateIdentityCoverage(
  registry: ModelRegistry,
  requiredSuiteVersions: string[],
  root?: string,
): { ineligibleModels: IneligibleModel[]; eligibleModelCount: number } {
  const ineligibleModels: IneligibleModel[] = [];
  let eligibleModelCount = 0;

  for (const [registryKey, model] of Object.entries(registry.models)) {
    const suiteVersion = model.nativeCapability?.certification?.certificationSuiteVersion?.trim();
    if (!suiteVersion || !requiredSuiteVersions.includes(suiteVersion)) {
      continue;
    }
    const nativeProvider = model.nativeCapability?.nativeProvider ?? model.supportedModel?.provider;
    if (!nativeProvider) {
      continue;
    }

    let subject;
    try {
      subject = resolveCertificationSubject({ provider: nativeProvider, model: registryKey, registry });
    } catch {
      // A model the registry cannot even resolve an identity for is a registry
      // problem, not certification drift; leave it out of both tallies.
      continue;
    }

    const eligibility = checkGlobalCertificationEligibility(
      subject.storageIdentity.provider,
      subject.storageIdentity.model,
      suiteVersion,
      'read-only',
      undefined,
      { root },
      subject.subject,
    );

    if (eligibility.eligible) {
      eligibleModelCount += 1;
    } else {
      ineligibleModels.push({ registryKey, reason: eligibility.reason });
    }
  }

  return { ineligibleModels, eligibleModelCount };
}

function nativeCertificationSuiteVersions(registry: ModelRegistry): string[] {
  return [...new Set(Object.values(registry.models)
    .map((model) => model.nativeCapability?.certification?.certificationSuiteVersion?.trim())
    .filter((suiteVersion): suiteVersion is string => Boolean(suiteVersion)))]
    .sort();
}

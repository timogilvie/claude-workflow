import { basename } from 'node:path';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './scenarios.ts';
import {
  buildGlobalCertificationPath,
  evaluateEligibility,
  type IneligibilityReason,
} from './loader.ts';
import {
  readCertification,
  type ReadResult,
  type StoreErrorCode,
} from './store.ts';
import { resolveCertificationStorageIdentity } from './identity.ts';
import { checkIdentity } from './validator.ts';

export type MigrationDecisionCode =
  | 'not-importable-v1-suite'
  | 'already-global'
  | 'stale-reuse-not-recommended'
  | 'schema-incompatible'
  | 'reusable-but-verify'
  | 'incompatible';

export interface MigrationInspectionResult {
  path: string;
  sizeBytes?: number;
  provider?: string;
  model?: string;
  suiteVersion?: string;
  phase?: string;
  certifiedAt?: string;
  ageDays?: number;
  globalArtifactPath?: string;
  globalArtifactExists: boolean;
  decision: MigrationDecisionCode;
  reason: string;
}

export function evaluateMigrationEligibility(input: {
  path: string;
  sizeBytes?: number;
  readResult?: ReadResult;
  globalArtifactExists?: (path: string) => boolean;
  now?: Date;
}): MigrationInspectionResult {
  const now = input.now ?? new Date();
  const read = input.readResult ?? readCertification(input.path);

  if (!read.ok) {
    return incompatibleResult(input.path, input.sizeBytes, 'schema-incompatible', read.error.code);
  }

  const artifact = read.artifact;
  const storageIdentity = resolveCertificationStorageIdentity(artifact.provider, artifact.model);
  const globalArtifactPath = buildGlobalCertificationPath(
    storageIdentity.provider,
    storageIdentity.model,
    artifact.suiteVersion,
  );
  const globalArtifactExists = input.globalArtifactExists?.(globalArtifactPath) ?? false;
  const ageDays = Math.floor((now.getTime() - Date.parse(artifact.certifiedAt)) / (24 * 60 * 60 * 1000));
  const base = {
    path: input.path,
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    provider: artifact.provider,
    model: artifact.model,
    suiteVersion: artifact.suiteVersion,
    phase: artifact.phase,
    certifiedAt: artifact.certifiedAt,
    ageDays,
    globalArtifactPath,
    globalArtifactExists,
  };

  if (globalArtifactExists) {
    return {
      ...base,
      decision: 'already-global',
      reason: 'global artifact already exists for this canonical identity and suite',
    };
  }

  if (artifact.suiteVersion !== DEFAULT_CERTIFICATION_SUITE_VERSION || basename(input.path) === 'v1.json') {
    return {
      ...base,
      decision: 'not-importable-v1-suite',
      reason: `legacy suite ${artifact.suiteVersion} must be re-certified with ${DEFAULT_CERTIFICATION_SUITE_VERSION}`,
    };
  }

  const identityError = checkIdentity(artifact, storageIdentity.provider, storageIdentity.model);
  if (identityError) {
    return {
      ...base,
      decision: 'incompatible',
      reason: `artifact identity mismatch: ${identityError}`,
    };
  }

  const eligibility = evaluateEligibility(
    artifact,
    DEFAULT_CERTIFICATION_SUITE_VERSION,
    artifact.phase,
    now,
  );
  if (!eligibility.eligible) {
    return {
      ...base,
      decision: eligibility.reason === 'stale' ? 'stale-reuse-not-recommended' : 'incompatible',
      reason: migrationReasonFromEligibility(eligibility.reason),
    };
  }

  return {
    ...base,
    decision: 'reusable-but-verify',
    reason: 'v2 artifact is structurally compatible; verify before importing',
  };
}

function incompatibleResult(
  path: string,
  sizeBytes: number | undefined,
  decision: MigrationDecisionCode,
  errorCode: StoreErrorCode,
): MigrationInspectionResult {
  return {
    path,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    globalArtifactExists: false,
    decision,
    reason: errorCode,
  };
}

function migrationReasonFromEligibility(reason: IneligibilityReason): string {
  switch (reason) {
    case 'missing':
    case 'malformed':
      return reason;
    case 'wrong-version':
      return 'schema or suite version does not match the required v2 suite';
    case 'stale':
      return 'artifact is expired and should be re-certified';
    case 'phase-insufficient':
      return 'artifact phase does not satisfy its declared certification requirement';
    case 'scenario-failure':
      return 'one or more certification scenarios failed';
  }
}

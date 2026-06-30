import {
  CERTIFICATION_SCHEMA_VERSION,
  CERTIFICATION_TTL_DAYS,
  allScenariosPassed,
  isCertificationFresh,
  phaseSatisfies,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';

export type ValidationErrorCode =
  | 'schema-version-mismatch'
  | 'suite-version-mismatch'
  | 'expired'
  | 'phase-insufficient'
  | 'limitation-conflict'
  | 'identity-mismatch'
  | 'scenario-failure';

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface CertificationExpectations {
  expectedProvider: string;
  expectedModel: string;
  expectedSuiteVersion: string;
  requiredPhase: CertificationPhase;
  /** Conflict-checked against knownLimitations */
  requiredCapabilities?: string[];
  /** Defaults to new Date() */
  now?: Date;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

/**
 * Aggregate validator: runs ALL checks (no short-circuit) and returns
 * one entry per failed check so diagnostics are complete.
 * Pure, synchronous, no I/O.
 */
export function validateCertification(
  record: NativeCertificationArtifact,
  expectations: CertificationExpectations,
): ValidationResult {
  const now = expectations.now ?? new Date();

  const errors: ValidationError[] = [];

  const schemaErr = checkSchemaVersion(record);
  if (schemaErr) errors.push(schemaErr);

  const suiteErr = checkSuiteVersion(record, expectations.expectedSuiteVersion);
  if (suiteErr) errors.push(suiteErr);

  const expiredErr = checkNotExpired(record, now);
  if (expiredErr) errors.push(expiredErr);

  const phaseErr = checkPhaseSatisfies(record, expectations.requiredPhase);
  if (phaseErr) errors.push(phaseErr);

  const identityErr = checkIdentity(record, expectations.expectedProvider, expectations.expectedModel);
  if (identityErr) errors.push(identityErr);

  const limErr = checkLimitations(record, expectations.requiredCapabilities);
  if (limErr) errors.push(limErr);

  const scenarioErr = checkScenarios(record);
  if (scenarioErr) errors.push(scenarioErr);

  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}

/**
 * Check that the artifact's schemaVersion matches the current contract version.
 */
export function checkSchemaVersion(record: NativeCertificationArtifact): ValidationError | null {
  if (record.schemaVersion === CERTIFICATION_SCHEMA_VERSION) return null;
  return {
    code: 'schema-version-mismatch',
    message: `schema version mismatch: artifact=${record.schemaVersion} expected=${CERTIFICATION_SCHEMA_VERSION}`,
    detail: { actual: record.schemaVersion, expected: CERTIFICATION_SCHEMA_VERSION },
  };
}

/**
 * Check that the artifact's suiteVersion matches the expected version.
 */
export function checkSuiteVersion(
  record: NativeCertificationArtifact,
  expected: string,
): ValidationError | null {
  if (record.suiteVersion === expected) return null;
  return {
    code: 'suite-version-mismatch',
    message: `suite version mismatch: artifact=${record.suiteVersion} expected=${expected}`,
    detail: { actual: record.suiteVersion, expected },
  };
}

/**
 * Check that the artifact has not expired relative to `now`.
 */
export function checkNotExpired(
  record: NativeCertificationArtifact,
  now: Date,
): ValidationError | null {
  if (isCertificationFresh(record, now)) return null;

  if (record.expiresAt) {
    const expiresAt = record.expiresAt;
    return {
      code: 'expired',
      message: `certification expired: now=${now.toISOString()} >= boundary=${expiresAt} (via expiresAt)`,
      detail: {
        certifiedAt: record.certifiedAt,
        ttlDays: null,
        expiresAt,
        now: now.toISOString(),
        boundary: expiresAt,
        source: 'expiresAt',
      },
    };
  }

  const certifiedAt = new Date(record.certifiedAt);
  const expiryMs = certifiedAt.getTime() + CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const boundary = new Date(expiryMs).toISOString();
  return {
    code: 'expired',
    message: `certification expired: now=${now.toISOString()} >= boundary=${boundary} (via certifiedAt+ttl)`,
    detail: {
      certifiedAt: record.certifiedAt,
      ttlDays: CERTIFICATION_TTL_DAYS,
      expiresAt: null,
      now: now.toISOString(),
      boundary,
      source: 'derived',
    },
  };
}

/**
 * Check that the artifact's phase satisfies the required phase.
 */
export function checkPhaseSatisfies(
  record: NativeCertificationArtifact,
  required: CertificationPhase,
): ValidationError | null {
  if (phaseSatisfies(record.phase, required)) return null;
  return {
    code: 'phase-insufficient',
    message: `phase insufficient: artifact=${record.phase} does not satisfy required=${required}`,
    detail: { actual: record.phase, required },
  };
}

/**
 * Check that provider and model match the expected identity.
 * Returns a single error even when both fields mismatch; detail.fields lists all mismatches.
 */
export function checkIdentity(
  record: NativeCertificationArtifact,
  expectedProvider: string,
  expectedModel: string,
): ValidationError | null {
  const fields: string[] = [];
  if (record.provider !== expectedProvider) fields.push('provider');
  if (record.model !== expectedModel) fields.push('model');

  if (fields.length === 0) return null;

  const parts = fields.map(f => {
    const actual = f === 'provider' ? record.provider : record.model;
    const expected = f === 'provider' ? expectedProvider : expectedModel;
    return `identity mismatch (${f}): artifact=${actual} expected=${expected}`;
  });

  return {
    code: 'identity-mismatch',
    message: parts.join('; '),
    detail: {
      fields,
      actualProvider: record.provider,
      expectedProvider,
      actualModel: record.model,
      expectedModel,
    },
  };
}

/**
 * Check that required capabilities are not blocked by the artifact's knownLimitations.
 * Case-sensitive exact match. Returns null when requiredCapabilities is empty or undefined.
 */
export function checkLimitations(
  record: NativeCertificationArtifact,
  requiredCapabilities: string[] | undefined,
): ValidationError | null {
  if (!requiredCapabilities || requiredCapabilities.length === 0) return null;

  const limitations = record.knownLimitations ?? [];
  const conflicting = requiredCapabilities.filter(cap => limitations.includes(cap));

  if (conflicting.length === 0) return null;

  return {
    code: 'limitation-conflict',
    message: `limitation conflict: artifact declares limitations=[${limitations.join(', ')}], required capabilities=[${requiredCapabilities.join(', ')}], intersecting=[${conflicting.join(', ')}]`,
    detail: {
      knownLimitations: limitations,
      requiredCapabilities,
      conflicting,
    },
  };
}

/**
 * Check that all scenarios in the artifact passed.
 * Mirrors evaluateEligibility's scenario-failure check.
 */
export function checkScenarios(record: NativeCertificationArtifact): ValidationError | null {
  if (allScenariosPassed(record)) return null;

  const failed = record.scenarios.filter(s => !s.passed).map(s => s.scenarioId);
  const isEmpty = record.scenarios.length === 0;

  return {
    code: 'scenario-failure',
    message: isEmpty
      ? 'scenario-failure: no scenarios in certification artifact'
      : `scenario-failure: failed scenarios=[${failed.join(', ')}]`,
    detail: { failedScenarioIds: failed, totalScenarios: record.scenarios.length },
  };
}

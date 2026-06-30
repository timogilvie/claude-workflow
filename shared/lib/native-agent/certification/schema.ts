/**
 * Native agent certification contract.
 *
 * Defines the shared schema, phase ordering, TTL policy, and eligibility
 * helpers for native provider/model phase certification artifacts.
 *
 * ## Storage path contract
 *
 * `.wavemill/native-agent-certifications/<provider>/<model>/<suite-version>.json`
 *
 * ## Phase ordering
 *
 * Phases are ordered: read-only < patch < workflow
 * A higher certification satisfies all lower required phases.
 *
 * ## TTL policy
 *
 * Default TTL is 60 days from `certifiedAt`. If `expiresAt` is present on
 * the artifact, it takes precedence over the derived TTL.
 *
 * @module native-agent/certification/schema
 */

export const CERTIFICATION_SCHEMA_VERSION = 1 as const;

/** Path prefix relative to repo root */
export const CERTIFICATION_BASE_PATH = '.wavemill/native-agent-certifications' as const;

/**
 * Default certification TTL in days.
 *
 * 60 days balances freshness against certification overhead. 30 days was
 * considered too frequent for low-churn providers; 90 days risks staleness
 * after provider API changes. See docs/native-certification-contract.md.
 */
export const CERTIFICATION_TTL_DAYS = 60 as const;

/** Ordered list of phases, from least to most permissive. */
export const PHASE_ORDER = ['read-only', 'patch', 'workflow'] as const;

export type CertificationPhase = (typeof PHASE_ORDER)[number];

/**
 * Result of a single scenario execution within a certification run.
 */
export interface ScenarioResult {
  /** Stable scenario identifier within the suite */
  scenarioId: string;
  /** Whether this scenario passed */
  passed: boolean;
  /** Optional human-readable failure message */
  failureMessage?: string;
  /** Number of attempts made before final result */
  retryCount?: number;
}

/**
 * A native agent certification artifact.
 *
 * Stored at `.wavemill/native-agent-certifications/<provider>/<model>/<suite-version>.json`.
 * Written after a full certification run; evaluated by downstream consumers
 * before allowing native agent use in a phase.
 */
export interface NativeCertificationArtifact {
  /** Schema version for forward compatibility */
  schemaVersion: typeof CERTIFICATION_SCHEMA_VERSION;
  /** Provider identifier (e.g. "anthropic", "openai", "openrouter") */
  provider: string;
  /** Model identifier (e.g. "claude-sonnet-4-6") */
  model: string;
  /** The certified phase level */
  phase: CertificationPhase;
  /** Suite version string that was run (matches the storage path segment) */
  suiteVersion: string;
  /** ISO 8601 datetime when certification was completed */
  certifiedAt: string;
  /**
   * Optional explicit expiry datetime (ISO 8601).
   * Takes precedence over the derived TTL from certifiedAt + CERTIFICATION_TTL_DAYS.
   */
  expiresAt?: string;
  /** Per-scenario results from the certification run */
  scenarios: ScenarioResult[];
  /** Optional known limitations or caveats for this certification */
  knownLimitations?: string[];
  /** Total retry count across all scenarios */
  totalRetryCount?: number;
}

/**
 * Return true if `actual` phase satisfies `required` phase.
 *
 * Phase ordering: read-only < patch < workflow.
 * A higher phase satisfies all lower required phases.
 */
export function phaseSatisfies(actual: CertificationPhase, required: CertificationPhase): boolean {
  return PHASE_ORDER.indexOf(actual) >= PHASE_ORDER.indexOf(required);
}

/**
 * Return true if the certification is fresh relative to `now`.
 *
 * If `expiresAt` is present, staleness is `now >= expiresAt`.
 * Otherwise staleness is derived from `certifiedAt + CERTIFICATION_TTL_DAYS`.
 */
export function isCertificationFresh(artifact: NativeCertificationArtifact, now: Date): boolean {
  if (artifact.expiresAt) {
    return now < new Date(artifact.expiresAt);
  }
  const certifiedAt = new Date(artifact.certifiedAt);
  const expiryMs = certifiedAt.getTime() + CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() < expiryMs;
}

/**
 * Return true if all required scenarios passed.
 *
 * A scenario is required when it exists in the results — any failed scenario
 * blocks eligibility. Suites with no scenarios are treated as not certified.
 */
export function allScenariosPassed(artifact: NativeCertificationArtifact): boolean {
  if (artifact.scenarios.length === 0) {
    return false;
  }
  return artifact.scenarios.every(s => s.passed);
}

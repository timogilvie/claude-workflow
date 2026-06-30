import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CERTIFICATION_BASE_PATH,
  CERTIFICATION_SCHEMA_VERSION,
  allScenariosPassed,
  isCertificationFresh,
  phaseSatisfies,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';

/**
 * Stable reason codes returned when a certification is ineligible.
 *
 * All ineligibility paths return a structured reason rather than throwing,
 * so callers can fail closed without try/catch.
 */
export type IneligibilityReason =
  | 'missing'
  | 'malformed'
  | 'wrong-version'
  | 'stale'
  | 'phase-insufficient'
  | 'scenario-failure';

export type CertificationEligibility =
  | { eligible: true; artifact: NativeCertificationArtifact }
  | { eligible: false; reason: IneligibilityReason; artifact?: NativeCertificationArtifact };

/** Characters that are not safe in a path segment */
const UNSAFE_SEGMENT = /[/\\\0]/;

/**
 * Validate that a path segment is non-empty and contains no traversal characters.
 *
 * Rejects empty strings, the traversal segments `.` and `..`, and any segment
 * containing `/`, `\`, or NUL. Dots inside the segment (e.g. `gpt-5.5`,
 * `gemini-2.5-pro`) are permitted so model IDs work as path components.
 * Does not normalize — callers must supply canonical identifiers.
 */
export function isValidPathSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  if (UNSAFE_SEGMENT.test(segment)) return false;
  return true;
}

/**
 * Build the storage path for a certification artifact.
 *
 * Path contract: `<repoDir>/.wavemill/native-agent-certifications/<provider>/<model>/<suiteVersion>.json`
 *
 * @throws {Error} if any segment fails the safety check
 */
export function buildCertificationPath(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
): string {
  for (const [name, value] of [['provider', provider], ['model', model], ['suiteVersion', suiteVersion]] as const) {
    if (!isValidPathSegment(value)) {
      throw new Error(`Invalid certification path segment for ${name}: ${JSON.stringify(value)}`);
    }
  }
  return join(repoDir, CERTIFICATION_BASE_PATH, provider, model, `${suiteVersion}.json`);
}

/**
 * Parse provider, model, and suite version from an artifact path.
 *
 * Returns undefined when the path does not match the expected layout.
 */
export function parseCertificationPath(
  path: string,
): { provider: string; model: string; suiteVersion: string } | undefined {
  // Normalize separators for cross-platform safety
  const normalized = path.replace(/\\/g, '/');
  const marker = `${CERTIFICATION_BASE_PATH}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return undefined;

  const relative = normalized.slice(idx + marker.length);
  const parts = relative.split('/');
  // Expect: <provider>/<model>/<suiteVersion>.json
  if (parts.length !== 3) return undefined;

  const [provider, model, filename] = parts;
  if (!filename.endsWith('.json')) return undefined;

  const suiteVersion = filename.slice(0, -'.json'.length);
  if (
    !isValidPathSegment(provider)
    || !isValidPathSegment(model)
    || !isValidPathSegment(suiteVersion)
  ) {
    return undefined;
  }

  return { provider, model, suiteVersion };
}

/**
 * Load and structurally validate a certification artifact from disk.
 *
 * Returns a structured ineligibility result for missing files, parse
 * failures, and schema mismatches. Never throws on expected error paths.
 */
export function loadCertification(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
): { ok: true; artifact: NativeCertificationArtifact } | { ok: false; reason: 'missing' | 'malformed' } {
  let path: string;
  try {
    path = buildCertificationPath(repoDir, provider, model, suiteVersion);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!existsSync(path)) {
    return { ok: false, reason: 'missing' };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { ok: false, reason: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const artifact = parseArtifact(parsed);
  if (!artifact) {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, artifact };
}

/**
 * Evaluate whether a loaded certification artifact grants eligibility for a phase.
 *
 * Checks are applied in order; the first failure short-circuits:
 * 1. Schema version mismatch → `wrong-version`
 * 2. Suite version mismatch → `wrong-version`
 * 3. Staleness (TTL or expiresAt) → `stale`
 * 4. Phase insufficient → `phase-insufficient`
 * 5. Any scenario failure → `scenario-failure`
 *
 * Pass `now` to make TTL evaluation deterministic in tests.
 */
export function evaluateEligibility(
  artifact: NativeCertificationArtifact,
  requiredSuiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
): CertificationEligibility {
  if (artifact.schemaVersion !== CERTIFICATION_SCHEMA_VERSION) {
    return { eligible: false, reason: 'wrong-version', artifact };
  }

  if (artifact.suiteVersion !== requiredSuiteVersion) {
    return { eligible: false, reason: 'wrong-version', artifact };
  }

  if (!isCertificationFresh(artifact, now)) {
    return { eligible: false, reason: 'stale', artifact };
  }

  if (!phaseSatisfies(artifact.phase, requiredPhase)) {
    return { eligible: false, reason: 'phase-insufficient', artifact };
  }

  if (!allScenariosPassed(artifact)) {
    return { eligible: false, reason: 'scenario-failure', artifact };
  }

  return { eligible: true, artifact };
}

/**
 * Combined load + evaluate helper.
 *
 * Loads the artifact from disk and evaluates eligibility in one call.
 * All failure paths return a structured ineligibility result.
 */
export function checkCertificationEligibility(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
): CertificationEligibility {
  const loaded = loadCertification(repoDir, provider, model, suiteVersion);
  if (!loaded.ok) {
    return { eligible: false, reason: loaded.reason };
  }
  return evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now);
}

function parseArtifact(input: unknown): NativeCertificationArtifact | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }

  const c = input as Record<string, unknown>;

  if (
    c.schemaVersion !== CERTIFICATION_SCHEMA_VERSION
    || typeof c.provider !== 'string'
    || typeof c.model !== 'string'
    || typeof c.phase !== 'string'
    || !(['read-only', 'patch', 'workflow'] as string[]).includes(c.phase)
    || typeof c.suiteVersion !== 'string'
    || typeof c.certifiedAt !== 'string'
    || !Array.isArray(c.scenarios)
  ) {
    return undefined;
  }

  if (c.expiresAt !== undefined && typeof c.expiresAt !== 'string') {
    return undefined;
  }

  if (c.knownLimitations !== undefined) {
    if (!Array.isArray(c.knownLimitations) || !c.knownLimitations.every(l => typeof l === 'string')) {
      return undefined;
    }
  }

  if (c.totalRetryCount !== undefined && typeof c.totalRetryCount !== 'number') {
    return undefined;
  }

  const scenarios = parseScenarios(c.scenarios);
  if (!scenarios) return undefined;

  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider: c.provider,
    model: c.model,
    phase: c.phase as CertificationPhase,
    suiteVersion: c.suiteVersion,
    certifiedAt: c.certifiedAt,
    scenarios,
  };

  if (typeof c.expiresAt === 'string') artifact.expiresAt = c.expiresAt;
  if (Array.isArray(c.knownLimitations)) artifact.knownLimitations = c.knownLimitations as string[];
  if (typeof c.totalRetryCount === 'number') artifact.totalRetryCount = c.totalRetryCount;

  return artifact;
}

function parseScenarios(
  raw: unknown[],
): NativeCertificationArtifact['scenarios'] | undefined {
  const results = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const e = entry as Record<string, unknown>;
    if (typeof e.scenarioId !== 'string' || typeof e.passed !== 'boolean') return undefined;
    if (e.failureMessage !== undefined && typeof e.failureMessage !== 'string') return undefined;
    if (e.retryCount !== undefined && typeof e.retryCount !== 'number') return undefined;

    const scenario: NativeCertificationArtifact['scenarios'][number] = {
      scenarioId: e.scenarioId,
      passed: e.passed,
    };
    if (typeof e.failureMessage === 'string') scenario.failureMessage = e.failureMessage;
    if (typeof e.retryCount === 'number') scenario.retryCount = e.retryCount;

    results.push(scenario);
  }
  return results;
}

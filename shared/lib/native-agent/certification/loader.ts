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
import {
  isValidCertificationPathSegment,
  resolveCertificationStorageIdentity,
} from './identity.ts';
import {
  buildCertificationPathFromRoot,
  buildScopedCertificationPath,
  resolveLegacyCertificationRoot,
  type CertificationStorageOptions,
  type CertificationStorageScope,
} from './storage.ts';
import { checkIdentity } from './validator.ts';

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

export const isValidPathSegment = isValidCertificationPathSegment;

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
  const identity = resolveCertificationStorageIdentity(provider, model);

  for (const [name, value] of [
    ['provider', identity.provider],
    ['model', identity.model],
    ['suiteVersion', suiteVersion],
  ] as const) {
    if (!isValidPathSegment(value)) {
      throw new Error(`Invalid certification path segment for ${name}: ${JSON.stringify(value)}`);
    }
  }
  return join(repoDir, CERTIFICATION_BASE_PATH, identity.provider, identity.model, `${suiteVersion}.json`);
}

export function buildGlobalCertificationPath(
  provider: string,
  model: string,
  suiteVersion: string,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): string {
  return buildScopedCertificationPath({ ...options, scope: 'global' }, provider, model, suiteVersion);
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

export function loadCertificationFromPath(
  path: string,
): { ok: true; artifact: NativeCertificationArtifact } | { ok: false; reason: 'missing' | 'malformed' } {
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

export type ScopedLoadCertificationResult =
  | { ok: true; artifact: NativeCertificationArtifact; path: string; scope: CertificationStorageScope }
  | { ok: false; reason: 'missing' | 'malformed'; path?: string; scope: CertificationStorageScope };

export function loadGlobalCertification(
  provider: string,
  model: string,
  suiteVersion: string,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): ScopedLoadCertificationResult {
  let path: string;
  try {
    path = buildGlobalCertificationPath(provider, model, suiteVersion, options);
  } catch {
    return { ok: false, reason: 'malformed', scope: 'global' };
  }
  const loaded = loadCertificationFromPath(path);
  return loaded.ok
    ? { ...loaded, path, scope: 'global' }
    : { ...loaded, path, scope: 'global' };
}

/**
 * Load a repo-local certification artifact.
 *
 * Deprecated: this is migration-only compatibility for legacy v1/v2 repo
 * artifacts. Runtime routing, provider gates, and reporting must read the
 * global certification store instead.
 */
export function loadLegacyCertification(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
): ScopedLoadCertificationResult {
  let path: string;
  try {
    path = buildCertificationPathFromRoot(
      resolveLegacyCertificationRoot(repoDir),
      provider,
      model,
      suiteVersion,
    );
  } catch {
    return { ok: false, reason: 'malformed', scope: 'legacy-repo' };
  }

  const loaded = loadCertificationFromPath(path);
  return loaded.ok
    ? { ...loaded, path, scope: 'legacy-repo' }
    : { ...loaded, path, scope: 'legacy-repo' };
}

/**
 * Compatibility wrapper retained for older callers.
 *
 * Despite the historical name, this no longer falls back to repo-local
 * artifacts. The global store is the only runtime source of truth.
 */
export function loadSharedCertificationWithLegacyFallback(
  _repoDir: string | undefined,
  provider: string,
  model: string,
  suiteVersion: string,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): ScopedLoadCertificationResult {
  return loadGlobalCertification(provider, model, suiteVersion, options);
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

export type ScopedCertificationEligibility = CertificationEligibility & {
  artifactPath?: string;
  storageScope?: CertificationStorageScope;
};

export function checkSharedCertificationEligibility(
  repoDir: string | undefined,
  provider: string,
  model: string,
  suiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
): ScopedCertificationEligibility {
  const loaded = loadSharedCertificationWithLegacyFallback(repoDir, provider, model, suiteVersion);
  if (!loaded.ok) {
    return {
      eligible: false,
      reason: loaded.reason,
      ...(loaded.path ? { artifactPath: loaded.path } : {}),
      storageScope: loaded.scope,
    };
  }
  const identity = resolveCertificationStorageIdentity(provider, model);
  if (checkIdentity(loaded.artifact, identity.provider, identity.model)) {
    return {
      eligible: false,
      reason: 'malformed',
      artifact: loaded.artifact,
      artifactPath: loaded.path,
      storageScope: loaded.scope,
    };
  }
  return {
    ...evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now),
    artifactPath: loaded.path,
    storageScope: loaded.scope,
  };
}

export function checkGlobalCertificationEligibility(
  provider: string,
  model: string,
  suiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
): ScopedCertificationEligibility {
  const loaded = loadGlobalCertification(provider, model, suiteVersion);
  if (!loaded.ok) {
    return {
      eligible: false,
      reason: loaded.reason,
      ...(loaded.path ? { artifactPath: loaded.path } : {}),
      storageScope: 'global',
    };
  }
  const identity = resolveCertificationStorageIdentity(provider, model);
  if (checkIdentity(loaded.artifact, identity.provider, identity.model)) {
    return {
      eligible: false,
      reason: 'malformed',
      artifact: loaded.artifact,
      artifactPath: loaded.path,
      storageScope: 'global',
    };
  }
  return {
    ...evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now),
    artifactPath: loaded.path,
    storageScope: 'global',
  };
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

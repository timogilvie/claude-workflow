import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CERTIFICATION_BASE_PATH,
  CERTIFICATION_SCHEMA_VERSION,
  allScenariosPassed,
  artifactHasSubject,
  isCertificationFresh,
  phaseSatisfies,
  type AnyNativeCertificationArtifact,
  type CertificationSubject,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';
import {
  isValidCertificationPathSegment,
  resolveCertificationStorageIdentity,
  subjectsEqual,
} from './identity.ts';
import {
  buildScopedCertificationPath,
  type CertificationStorageOptions,
  type CertificationStorageScope,
} from './storage.ts';

/**
 * Stable reason codes returned when a certification is ineligible.
 *
 * All ineligibility paths return a structured reason rather than throwing,
 * so callers can fail closed without try/catch.
 */
export type IneligibilityReason =
  | 'missing'
  | 'malformed'
  | 'identity-reidentified'
  | 'wrong-version'
  | 'stale'
  | 'phase-insufficient'
  | 'scenario-failure';

export type CertificationEligibility =
  | { eligible: true; artifact: AnyNativeCertificationArtifact }
  | { eligible: false; reason: IneligibilityReason; artifact?: AnyNativeCertificationArtifact };

export const isValidPathSegment = isValidCertificationPathSegment;

/**
 * Build the legacy repo-scoped storage path for a certification artifact.
 *
 * Path contract: `<repoDir>/.wavemill/native-agent-certifications/<provider>/<model>/<suiteVersion>.json`
 *
 * @throws {Error} if any segment fails the safety check
 */
export function buildLegacyRepoCertificationPath(
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

/**
 * @deprecated Use buildLegacyRepoCertificationPath for legacy repo-scoped artifacts,
 * or buildScopedCertificationPath/buildGlobalCertificationPath with an explicit scope.
 */
export function buildCertificationPath(
  repoDir: string,
  provider: string,
  model: string,
  suiteVersion: string,
): string {
  return buildLegacyRepoCertificationPath(repoDir, provider, model, suiteVersion);
}

/**
 * Build the storage path for a shared global certification artifact.
 *
 * This reads the caller's process-wide global store unless `root` is provided.
 * Prefer passing `root` when correctness depends on the selected store.
 *
 * Path contract: `<global-root>/<provider>/<model>/<suiteVersion>.json`
 *
 * @throws {Error} if any segment fails the safety check
 */
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
): { ok: true; artifact: AnyNativeCertificationArtifact } | { ok: false; reason: 'missing' | 'malformed' } {
  let path: string;
  try {
    path = buildLegacyRepoCertificationPath(repoDir, provider, model, suiteVersion);
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
): { ok: true; artifact: AnyNativeCertificationArtifact } | { ok: false; reason: 'missing' | 'malformed' } {
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
  | { ok: true; artifact: AnyNativeCertificationArtifact; path: string; scope: CertificationStorageScope }
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

export function loadSharedCertificationWithLegacyFallback(
  repoDir: string | undefined,
  provider: string,
  model: string,
  suiteVersion: string,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): ScopedLoadCertificationResult {
  void repoDir;
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
  artifact: AnyNativeCertificationArtifact,
  requiredSuiteVersion: string,
  requiredPhase: CertificationPhase,
  now: Date = new Date(),
  expectedSubject?: CertificationSubject,
): CertificationEligibility {
  if (expectedSubject) {
    if (!artifactHasSubject(artifact) || !subjectsEqual(artifact.subject, expectedSubject)) {
      return { eligible: false, reason: 'identity-reidentified', artifact };
    }
    if (artifact.provider !== expectedSubject.providerId || artifact.model !== expectedSubject.providerModelId) {
      return { eligible: false, reason: 'identity-reidentified', artifact };
    }
  }

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
  expectedSubject?: CertificationSubject,
): CertificationEligibility {
  const loaded = loadCertification(repoDir, provider, model, suiteVersion);
  if (!loaded.ok) {
    return { eligible: false, reason: loaded.reason };
  }
  return evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now, expectedSubject);
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
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
  expectedSubject?: CertificationSubject,
): ScopedCertificationEligibility {
  const loaded = loadSharedCertificationWithLegacyFallback(repoDir, provider, model, suiteVersion, options);
  if (!loaded.ok) {
    return {
      eligible: false,
      reason: loaded.reason,
      ...(loaded.path ? { artifactPath: loaded.path } : {}),
      storageScope: loaded.scope,
    };
  }
  return {
    ...evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now, expectedSubject),
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
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
  expectedSubject?: CertificationSubject,
): ScopedCertificationEligibility {
  const loaded = loadGlobalCertification(provider, model, suiteVersion, options);
  if (!loaded.ok) {
    return {
      eligible: false,
      reason: loaded.reason,
      ...(loaded.path ? { artifactPath: loaded.path } : {}),
      storageScope: 'global',
    };
  }
  return {
    ...evaluateEligibility(loaded.artifact, suiteVersion, requiredPhase, now, expectedSubject),
    artifactPath: loaded.path,
    storageScope: 'global',
  };
}

function parseArtifact(input: unknown): AnyNativeCertificationArtifact | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }

  const c = input as Record<string, unknown>;

  if (
    c.schemaVersion !== CERTIFICATION_SCHEMA_VERSION
    && c.schemaVersion !== 2
  ) {
    return undefined;
  }

  if (
    typeof c.provider !== 'string'
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

  const common = {
    provider: c.provider,
    model: c.model,
    phase: c.phase as CertificationPhase,
    suiteVersion: c.suiteVersion,
    certifiedAt: c.certifiedAt,
    scenarios,
  };

  const artifact: AnyNativeCertificationArtifact = c.schemaVersion === CERTIFICATION_SCHEMA_VERSION
    ? {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      subject: parseSubject(c.subject),
      ...common,
    }
    : {
      schemaVersion: 2,
      ...common,
    };

  if (artifact.schemaVersion === CERTIFICATION_SCHEMA_VERSION && !artifact.subject) {
    return undefined;
  }

  if (typeof c.expiresAt === 'string') artifact.expiresAt = c.expiresAt;
  if (Array.isArray(c.knownLimitations)) artifact.knownLimitations = c.knownLimitations as string[];
  if (typeof c.totalRetryCount === 'number') artifact.totalRetryCount = c.totalRetryCount;
  if (artifact.schemaVersion === CERTIFICATION_SCHEMA_VERSION) {
    const liveSmokeEvidence = parseLiveSmokeEvidence(c.liveSmokeEvidence);
    if (c.liveSmokeEvidence !== undefined && !liveSmokeEvidence) return undefined;
    if (liveSmokeEvidence) artifact.liveSmokeEvidence = liveSmokeEvidence;
  }

  return artifact;
}

function parseSubject(raw: unknown): NativeCertificationArtifact['subject'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.registryKey !== 'string'
    || typeof s.nativeProvider !== 'string'
    || typeof s.providerId !== 'string'
    || typeof s.providerModelId !== 'string'
    || typeof s.providerNativeId !== 'string'
    || typeof s.identityRevision !== 'number'
    || typeof s.identityFingerprint !== 'string'
    || typeof s.catalogHash !== 'string'
  ) {
    return undefined;
  }
  return {
    registryKey: s.registryKey,
    nativeProvider: s.nativeProvider,
    providerId: s.providerId,
    providerModelId: s.providerModelId,
    providerNativeId: s.providerNativeId,
    identityRevision: s.identityRevision,
    identityFingerprint: s.identityFingerprint,
    catalogHash: s.catalogHash,
  };
}

function parseLiveSmokeEvidence(raw: unknown): NativeCertificationArtifact['liveSmokeEvidence'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.requestedWireId !== 'string'
    || typeof e.catalogHash !== 'string'
    || typeof e.succeededAt !== 'string'
  ) {
    return undefined;
  }
  if (e.providerReturnedModel !== undefined && typeof e.providerReturnedModel !== 'string') {
    return undefined;
  }
  return {
    requestedWireId: e.requestedWireId,
    ...(typeof e.providerReturnedModel === 'string' ? { providerReturnedModel: e.providerReturnedModel } : {}),
    catalogHash: e.catalogHash,
    succeededAt: e.succeededAt,
  };
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

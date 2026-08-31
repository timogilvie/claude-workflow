import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mutateJsonState } from '../../state-mutex.ts';
import {
  getEffectiveRegistry,
  resolveModelIdentity,
  type ModelRegistry,
  type NativeProviderName,
} from '../../model-registry.ts';
import { hashLaunchPriorityFixture } from '../../openrouter-catalog.ts';
import { resolveCertificationStorage } from './storage.ts';
import type { SuiteCoverageResult, SuiteCoverageStatus } from './coverage.ts';
import {
  certifySelectedNativeAgents,
  type CertifyAllEntry,
  type CertifyAllResult,
  type CertifySelectedTarget,
} from '../../../../tools/native-agent-certify.ts';

export interface AutoRemediationOptions {
  registry?: ModelRegistry;
  repoDir: string;
  coverage: SuiteCoverageResult;
  root?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  renewalWindowDays?: number;
  log?: (line: string) => void;
  certifyFn?: typeof certifySelectedNativeAgents;
  attemptCachePath?: string;
}

export interface AutoRemediationResult {
  attempted: boolean;
  mode: 'republish-matrix' | 'renewal' | 'noop' | 'blocked-by-loop-guard';
  targets: string[];
  published: string[];
  failed: Array<{ provider: string; model: string; reason: string }>;
  skipped: Array<{ provider: string; model: string; reason: string }>;
  attemptKey: string;
}

interface AttemptCache {
  attempts: Record<string, {
    at: string;
    outcome: 'success' | 'failed-once' | 'blocked';
    failedModels: string[];
  }>;
}

const EMPTY_ATTEMPT_CACHE: AttemptCache = { attempts: {} };
const ZERO_CATALOG_HASH = '0'.repeat(64);

export async function runCertificationAutoRemediation(
  opts: AutoRemediationOptions,
): Promise<AutoRemediationResult> {
  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const mode = remediationMode(opts.coverage);
  const targets = selectTargets(registry, opts.coverage, mode);
  const targetKeys = targets.map((target) => target.model).sort();
  const attemptKey = buildAttemptKey(opts.coverage.requiredSuiteVersion, targetKeys, opts.log);

  if (mode === 'noop' || targets.length === 0) {
    opts.log?.(`[certify-auto] coverage=${opts.coverage.status} reason=no-targets targets=0`);
    return emptyResult('noop', targetKeys, attemptKey);
  }

  const cachePath = opts.attemptCachePath
    ?? join(resolveCertificationStorage({ scope: 'global', root: opts.root }).root, '.auto-remediation-attempts.json');
  let existing: AttemptCache['attempts'][string]['outcome'] | undefined;
  try {
    existing = await readAttempt(cachePath, attemptKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.log?.(`[certify-auto] BLOCKED by loop guard for key ${attemptKey} - ${reason}`);
    return {
      ...emptyResult('blocked-by-loop-guard', targetKeys, attemptKey),
      failed: targets.map((target) => ({
        provider: target.provider,
        model: target.model,
        reason: `auto-remediation attempt cache unavailable: ${reason}`,
      })),
    };
  }
  if (existing === 'success') {
    // Successful attempts must not become a permanent suppression key. The
    // same catalog/suite/target set can legitimately need certification again
    // after TTL renewal or local artifact deletion. Only a prior failure is a
    // loop-guard signal.
    opts.log?.(`[certify-auto] coverage=${opts.coverage.status} reason=previous-success-retrying targets=${targets.length}`);
  }
  if (existing === 'failed-once' || existing === 'blocked') {
    opts.log?.(`[certify-auto] BLOCKED by loop guard for key ${attemptKey} - models: ${targetKeys.join(',')}`);
    await safeMarkAttempt(cachePath, attemptKey, 'blocked', targetKeys, opts.now, opts.log);
    return {
      ...emptyResult('blocked-by-loop-guard', targetKeys, attemptKey),
      failed: targets.map((target) => ({
        provider: target.provider,
        model: target.model,
        reason: 'auto-remediation already failed once for this certification identity',
      })),
    };
  }

  opts.log?.(`[certify-auto] coverage=${opts.coverage.status} reason=${mode} targets=${targets.length}`);

  let result: CertifyAllResult;
  try {
    result = await (opts.certifyFn ?? certifySelectedNativeAgents)({
      targets,
      phase: 'workflow',
      repoDir: opts.repoDir,
      dryRun: false,
      registry,
      env: stripLiveSmoke(opts.env ?? process.env),
      now: opts.now,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await safeMarkAttempt(cachePath, attemptKey, 'failed-once', targetKeys, opts.now, opts.log);
    opts.log?.(`[certify-auto] published=0 failed=${targets.length} skipped=0`);
    return {
      attempted: true,
      mode,
      targets: targetKeys,
      published: [],
      skipped: [],
      failed: targets.map((target) => ({ provider: target.provider, model: target.model, reason })),
      attemptKey,
    };
  }

  const failedModels = result.failed.map(formatEntryKey);
  await safeMarkAttempt(
    cachePath,
    attemptKey,
    result.failed.length > 0 ? 'failed-once' : 'success',
    failedModels,
    opts.now,
    opts.log,
  );
  opts.log?.(`[certify-auto] published=${result.published.length} failed=${result.failed.length} skipped=${result.skipped.length}`);

  return {
    attempted: true,
    mode,
    targets: targetKeys,
    published: result.published.map(formatEntryKey),
    failed: result.failed.map(({ provider, model, reason }) => ({
      provider,
      model,
      reason: reason ?? 'certification failed',
    })),
    skipped: result.skipped.map(({ provider, model, reason }) => ({
      provider,
      model,
      reason: reason ?? 'certification skipped',
    })),
    attemptKey,
  };
}

function remediationMode(coverage: SuiteCoverageResult): AutoRemediationResult['mode'] {
  if (coverage.status === 'identity-drift'
    || coverage.status === 'stale'
    || coverage.status === 'bump-without-publish'
    || coverage.status === 'empty-store') {
    return 'republish-matrix';
  }
  if (coverage.modelsInRenewalWindow.length > 0) {
    return 'renewal';
  }
  return 'noop';
}

function selectTargets(
  registry: ModelRegistry,
  coverage: SuiteCoverageResult,
  mode: AutoRemediationResult['mode'],
): CertifySelectedTarget[] {
  const requested = mode === 'renewal'
    ? new Set(coverage.modelsInRenewalWindow.map((model) => model.registryKey))
    : null;
  const targets: CertifySelectedTarget[] = [];

  for (const [registryKey, model] of Object.entries(registry.models)) {
    const capability = model.nativeCapability;
    if (!capability || capability.readOnlyNative === 'unsupported') continue;
    if (requested && !requested.has(registryKey)) continue;
    if (resolveModelIdentity(registry, registryKey).status === 'provisional') continue;
    targets.push({
      provider: capability.nativeProvider as NativeProviderName,
      model: registryKey,
    });
  }

  return targets.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function stripLiveSmoke(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.OPENROUTER_LIVE_SMOKE;
  return next;
}

function buildAttemptKey(
  suiteVersion: string,
  targetKeys: string[],
  log?: (line: string) => void,
): string {
  let catalogHash = ZERO_CATALOG_HASH;
  try {
    catalogHash = hashLaunchPriorityFixture();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`[certify-auto] catalogHash unavailable: ${message}`);
  }
  return createHash('sha256')
    .update(`${catalogHash}\n${suiteVersion}\n${targetKeys.join(',')}`, 'utf-8')
    .digest('hex');
}

async function readAttempt(cachePath: string, attemptKey: string): Promise<AttemptCache['attempts'][string]['outcome'] | undefined> {
  let outcome: AttemptCache['attempts'][string]['outcome'] | undefined;
  await mutateJsonState<AttemptCache>(
    cachePath,
    (cache) => {
      outcome = cache.attempts[attemptKey]?.outcome;
      return cache;
    },
    { createIfMissing: true, initial: EMPTY_ATTEMPT_CACHE },
  );
  return outcome;
}

async function markAttempt(
  cachePath: string,
  attemptKey: string,
  outcome: AttemptCache['attempts'][string]['outcome'],
  failedModels: string[],
  now?: () => Date,
): Promise<void> {
  await mutateJsonState<AttemptCache>(
    cachePath,
    (cache) => ({
      attempts: {
        ...cache.attempts,
        [attemptKey]: {
          at: (now ?? (() => new Date()))().toISOString(),
          outcome,
          failedModels,
        },
      },
    }),
    { createIfMissing: true, initial: EMPTY_ATTEMPT_CACHE },
  );
}

async function safeMarkAttempt(
  cachePath: string,
  attemptKey: string,
  outcome: AttemptCache['attempts'][string]['outcome'],
  failedModels: string[],
  now: (() => Date) | undefined,
  log: ((line: string) => void) | undefined,
): Promise<void> {
  try {
    await markAttempt(cachePath, attemptKey, outcome, failedModels, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`[certify-auto] attempt cache update failed: ${message}`);
  }
}

function emptyResult(
  mode: AutoRemediationResult['mode'],
  targets: string[],
  attemptKey: string,
): AutoRemediationResult {
  return {
    attempted: false,
    mode,
    targets,
    published: [],
    failed: [],
    skipped: [],
    attemptKey,
  };
}

function formatEntryKey(entry: CertifyAllEntry): string {
  return `${entry.provider}/${entry.model}`;
}

export function isCertificationAutoRemediationTrigger(status: SuiteCoverageStatus): boolean {
  return status === 'identity-drift'
    || status === 'stale'
    || status === 'bump-without-publish'
    || status === 'empty-store';
}

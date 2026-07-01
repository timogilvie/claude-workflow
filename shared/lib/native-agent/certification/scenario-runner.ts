/**
 * Certification scenario runner.
 *
 * Walks a list of CertificationScenario definitions, dispatches their
 * assertions, aggregates results into a typed HarnessReport, and enforces the
 * dry-run contract (dryRun reports are never live-certifiable).
 *
 * ## Status taxonomy
 *
 * - `pass`        — assertion returned `{ kind: 'pass' }`
 * - `fail`        — assertion returned `{ kind: 'fail' }` or threw an error
 * - `unsupported` — assertion returned `{ kind: 'unsupported' }` (loud, never silent)
 * - `not-run`     — scenario is classified `live-judged`; skipped by this harness
 *
 * ## Dry-run contract
 *
 * `runScenarios({ dryRun: true })` returns a report with `dryRun: true` and
 * `liveCertifiable: false`. The runner itself never writes a certification
 * artifact; that remains the caller's responsibility. A dry-run report must
 * never be promoted to a live certification — `liveCertifiable` is the
 * programmatic guard.
 *
 * @module native-agent/certification/scenario-runner
 */

import type { ScenarioResult } from './schema.ts';
import type {
  CertificationScenario,
  FailureClass,
  HarnessNotRunReason,
  HarnessUnsupportedReason,
  ScenarioCategory,
  ScenarioClassification,
  ScenarioAssertionOutcome,
} from './scenarios.ts';
import type { ModelRegistry, NativeProviderName, PiTransportKind } from '../../model-registry.ts';
import type { CertificationPhase } from './schema.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HarnessScenarioStatus = 'pass' | 'fail' | 'unsupported' | 'not-run';

export interface HarnessScenarioResult {
  scenarioId: string;
  category: ScenarioCategory;
  classification: ScenarioClassification;
  phase: CertificationPhase;
  status: HarnessScenarioStatus;
  detail?: string;
  reason?: HarnessUnsupportedReason | HarnessNotRunReason;
  knownLimitation?: string;
  attempts?: number;
  finalAttemptStatus?: Exclude<ScenarioAssertionOutcome['kind'], never>;
  failureClass?: FailureClass;
  durationMs: number;
}

export interface HarnessReport {
  provider: string;
  model: string;
  transport: PiTransportKind;
  results: HarnessScenarioResult[];
  countsByStatus: Record<HarnessScenarioStatus, number>;
  countsByCategory: Record<ScenarioCategory, number>;
  knownLimitations: string[];
  /** True when zero fail and zero unsupported results are present. */
  harnessPassed: boolean;
  /** True only when harnessPassed === true AND dryRun === false. */
  liveCertifiable: boolean;
  dryRun: boolean;
}

export interface RunScenariosOptions {
  provider: NativeProviderName;
  model: string;
  transport: PiTransportKind;
  scenarios: CertificationScenario[];
  registry?: ModelRegistry;
  dryRun?: boolean;
  /** Test injection point for timing; defaults to performance.now(). */
  now?: () => number;
  /** Bounded retry policy for live flake handling. Defaults to 3 total attempts. */
  retryPolicy?: { maxAttempts?: number };
  /** Injectable hook for future backoff behavior; defaults to a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export function classifyAttempt(outcome: ScenarioAssertionOutcome):
  | { kind: 'pass' }
  | { kind: 'classified'; failureClass: FailureClass } {
  switch (outcome.kind) {
    case 'pass':
      return { kind: 'pass' };
    case 'fail':
      return { kind: 'classified', failureClass: 'deterministic_failure' };
    case 'provider-flake':
      return { kind: 'classified', failureClass: 'provider_flake' };
    case 'unsupported':
      return { kind: 'classified', failureClass: 'unsupported_capability' };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a list of certification scenarios and return an aggregated HarnessReport.
 *
 * Deterministic scenarios have their assertion executed; live-judged scenarios
 * are returned as `not-run` without invoking any LLM or network call.
 *
 * Assertion errors are caught and surfaced as `fail` results — they are never
 * re-thrown or silently swallowed. This preserves the loud-fail invariant: a
 * broken assertion is always visible in the report.
 */
export async function runScenarios(opts: RunScenariosOptions): Promise<HarnessReport> {
  if (!Array.isArray(opts.scenarios)) {
    throw new TypeError('runScenarios: opts.scenarios must be an array');
  }
  if (!opts.provider || typeof opts.provider !== 'string') {
    throw new TypeError('runScenarios: opts.provider must be a non-empty string');
  }
  if (!opts.model || typeof opts.model !== 'string') {
    throw new TypeError('runScenarios: opts.model must be a non-empty string');
  }
  if (!opts.transport || typeof opts.transport !== 'string') {
    throw new TypeError('runScenarios: opts.transport must be a non-empty string');
  }

  const maxAttempts = opts.retryPolicy?.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('runScenarios: retryPolicy.maxAttempts must be an integer >= 1');
  }

  const ctx = {
    provider: opts.provider,
    model: opts.model,
    transport: opts.transport,
    registry: opts.registry,
  };

  const timer = opts.now ?? (() => performance.now());
  const dryRun = opts.dryRun ?? false;
  const sleep = opts.sleep ?? (async (_ms: number) => {});
  const results: HarnessScenarioResult[] = [];

  for (const scenario of opts.scenarios) {
    const start = timer();

    if (scenario.classification === 'live-judged') {
      results.push({
        scenarioId: scenario.id,
        category: scenario.category,
        classification: scenario.classification,
        phase: scenario.phase,
        status: 'not-run',
        reason: 'requires-live-judge',
        knownLimitation: scenario.knownLimitation,
        durationMs: timer() - start,
      });
      continue;
    }

    if (!scenario.assertion) {
      // Deterministic scenario with no assertion — treat as a catalog bug (fail loud).
      results.push({
        scenarioId: scenario.id,
        category: scenario.category,
        classification: scenario.classification,
        phase: scenario.phase,
        status: 'fail',
        detail: `Deterministic scenario "${scenario.id}" has no assertion function`,
        knownLimitation: scenario.knownLimitation,
        attempts: 1,
        finalAttemptStatus: 'fail',
        failureClass: 'deterministic_failure',
        durationMs: timer() - start,
      });
      continue;
    }

    let attempts = 0;
    let finalOutcome: ScenarioAssertionOutcome | undefined;
    let finalFailureClass: FailureClass | undefined;

    while (attempts < maxAttempts) {
      attempts += 1;

      let outcome: ScenarioAssertionOutcome;
      try {
        outcome = await scenario.assertion(ctx);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        finalOutcome = { kind: 'fail', detail: message };
        finalFailureClass = 'deterministic_failure';
        break;
      }

      finalOutcome = outcome;
      const classified = classifyAttempt(outcome);
      if (classified.kind === 'pass') {
        finalFailureClass = undefined;
        break;
      }

      finalFailureClass = classified.failureClass;
      if (classified.failureClass !== 'provider_flake' || attempts >= maxAttempts) {
        break;
      }

      await sleep(0);
    }

    const durationMs = timer() - start;
    const finalAttemptStatus = finalOutcome?.kind;

    switch (finalOutcome?.kind) {
      case 'pass':
        results.push({
          scenarioId: scenario.id,
          category: scenario.category,
          classification: scenario.classification,
          phase: scenario.phase,
          status: 'pass',
          knownLimitation: scenario.knownLimitation,
          attempts,
          finalAttemptStatus,
          durationMs,
        });
        break;

      case 'fail':
        results.push({
          scenarioId: scenario.id,
          category: scenario.category,
          classification: scenario.classification,
          phase: scenario.phase,
          status: 'fail',
          detail: finalOutcome.detail,
          knownLimitation: scenario.knownLimitation,
          attempts,
          finalAttemptStatus,
          failureClass: finalFailureClass,
          durationMs,
        });
        break;

      case 'provider-flake':
        results.push({
          scenarioId: scenario.id,
          category: scenario.category,
          classification: scenario.classification,
          phase: scenario.phase,
          status: 'fail',
          detail: finalOutcome.detail,
          knownLimitation: scenario.knownLimitation,
          attempts,
          finalAttemptStatus,
          failureClass: finalFailureClass,
          durationMs,
        });
        break;

      case 'unsupported':
        results.push({
          scenarioId: scenario.id,
          category: scenario.category,
          classification: scenario.classification,
          phase: scenario.phase,
          status: 'unsupported',
          reason: finalOutcome.reason,
          detail: finalOutcome.detail,
          knownLimitation: scenario.knownLimitation,
          attempts,
          finalAttemptStatus,
          failureClass: finalFailureClass,
          durationMs,
        });
        break;
    }
  }

  return aggregateReport(
    { provider: opts.provider, model: opts.model, transport: opts.transport, dryRun },
    results,
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Build a HarnessReport from a context and result list.
 *
 * Pure: no I/O, no side effects. Exported so callers can build reports from
 * partial or synthetic result lists in tests.
 */
export function aggregateReport(
  context: { provider: string; model: string; transport: PiTransportKind; dryRun: boolean },
  results: HarnessScenarioResult[],
): HarnessReport {
  const countsByStatus: Record<HarnessScenarioStatus, number> = {
    pass: 0,
    fail: 0,
    unsupported: 0,
    'not-run': 0,
  };

  const countsByCategory: Record<ScenarioCategory, number> = {
    tool: 0,
    usage: 0,
    transcript: 0,
    phase: 0,
  };

  const limitationSet = new Set<string>();

  for (const result of results) {
    countsByStatus[result.status]++;
    countsByCategory[result.category]++;
    if (result.knownLimitation) {
      limitationSet.add(result.knownLimitation);
    }
  }

  const harnessPassed = countsByStatus.fail === 0 && countsByStatus.unsupported === 0;
  const liveCertifiable = harnessPassed && !context.dryRun;

  return {
    provider: context.provider,
    model: context.model,
    transport: context.transport,
    results,
    countsByStatus,
    countsByCategory,
    knownLimitations: [...limitationSet],
    harnessPassed,
    liveCertifiable,
    dryRun: context.dryRun,
  };
}

// ---------------------------------------------------------------------------
// Artifact projection
// ---------------------------------------------------------------------------

/**
 * Project a HarnessScenarioResult to the persisted ScenarioResult shape.
 *
 * Use this only for live (non-dry-run) reports when building a
 * NativeCertificationArtifact to write via writeCertification. A dry-run
 * report's results can be projected via this function (the shape is valid),
 * but the report itself is flagged liveCertifiable: false — do not write a
 * dry-run report's artifact as a live certification.
 */
export function toArtifactScenario(result: HarnessScenarioResult): ScenarioResult {
  const passed = result.status === 'pass';
  const scenario: ScenarioResult = {
    scenarioId: result.scenarioId,
    passed,
  };
  if (result.attempts !== undefined) {
    scenario.attempts = result.attempts;
    scenario.retryCount = Math.max(0, result.attempts - 1);
  }
  if (result.finalAttemptStatus !== undefined) {
    scenario.finalAttemptStatus = result.finalAttemptStatus;
  }
  if (result.failureClass !== undefined) {
    scenario.failureClass = result.failureClass;
  }
  if (result.detail && !passed) {
    scenario.failureMessage = result.detail;
  }
  return scenario;
}

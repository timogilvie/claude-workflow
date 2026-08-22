import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { routeBatch } from './route-batch.ts';
import { runReview, type ReviewResult } from './review-engine.ts';
import type { ReviewContext } from './review-context-gatherer.ts';
import { evaluateTask } from './eval.ts';
import { expandIssue } from './issue-expander.ts';
import { errorMessage } from './error-utils.ts';
import { getHarnessRetentionConfig } from './config.ts';
import type { Outcomes } from './eval-schema.ts';

export const HARNESS_REPLAY_SCHEMA_VERSION = 1 as const;
export const HARNESS_REPLAY_SUITE_VERSION = 'harness-retention-v1' as const;
export const DEFAULT_HARNESS_REPLAY_SUITE_PATH =
  'shared/fixtures/harness-replay/harness-retention-v1/manifest.json' as const;
export const DEFAULT_HARNESS_REPLAY_REPORT_DIR = '.wavemill/harness-replay/reports' as const;

export type HarnessReplaySurface = 'routing' | 'review' | 'eval_judging' | 'issue_expansion';
export type HarnessReplayMode = 'shadow' | 'enforce';
export type HarnessReplayStatus = 'passed' | 'failed' | 'malformed' | 'error' | 'excluded';

export interface ReplaySourceProvenance {
  kind: 'artifact' | 'incident' | 'synthetic';
  path?: string;
  incident?: string;
  note?: string;
}

export interface RoutingReplayCaseInput {
  issueId?: string;
  prompt: string;
  expectedDecision: {
    planner: string;
    coder: string;
    reviewer: string;
  };
}

export interface ReviewReplayCaseInput {
  diff: string;
  plan?: string;
  taskPacket?: string;
  branch?: string;
  files?: string[];
  hasUiChanges?: boolean;
  expectedVerdict: ReviewResult['verdict'];
}

export interface EvalJudgingReplayCaseInput {
  taskPrompt: string;
  prReviewOutput?: string;
  outcomes: Outcomes;
  expectedSuccess: boolean;
}

export interface IssueExpansionReplayCaseInput {
  promptTemplate: string;
  issueContext: string;
  codebaseContext?: string;
  expectedTextSha256?: string;
  expectedIncludes?: string[];
}

export type HarnessReplayCase =
  | {
      schemaVersion: typeof HARNESS_REPLAY_SCHEMA_VERSION;
      suiteVersion: string;
      id: string;
      surface: 'routing';
      source: ReplaySourceProvenance;
      baselineStatus: 'pass' | 'fail';
      stable: boolean;
      input: RoutingReplayCaseInput;
    }
  | {
      schemaVersion: typeof HARNESS_REPLAY_SCHEMA_VERSION;
      suiteVersion: string;
      id: string;
      surface: 'review';
      source: ReplaySourceProvenance;
      baselineStatus: 'pass' | 'fail';
      stable: boolean;
      input: ReviewReplayCaseInput;
    }
  | {
      schemaVersion: typeof HARNESS_REPLAY_SCHEMA_VERSION;
      suiteVersion: string;
      id: string;
      surface: 'eval_judging';
      source: ReplaySourceProvenance;
      baselineStatus: 'pass' | 'fail';
      stable: boolean;
      input: EvalJudgingReplayCaseInput;
    }
  | {
      schemaVersion: typeof HARNESS_REPLAY_SCHEMA_VERSION;
      suiteVersion: string;
      id: string;
      surface: 'issue_expansion';
      source: ReplaySourceProvenance;
      baselineStatus: 'pass' | 'fail';
      stable: boolean;
      input: IssueExpansionReplayCaseInput;
    };

export interface HarnessReplaySuiteProbe {
  id: string;
  incident: 'ready_watchdog_merge_lane' | 'challenge_pairing_id_drift' | 'monitor_bundle_main_regen';
  caught: boolean;
  evidence: string;
}

export interface HarnessReplaySuite {
  schemaVersion: typeof HARNESS_REPLAY_SCHEMA_VERSION;
  suiteVersion: string;
  sampling: {
    previouslyPassing: number;
    previouslyFailing: number;
    incidentCases: number;
    rule: string;
  };
  holdOut: {
    promptIsolation: string;
    refreshPolicy: string;
  };
  probes: {
    stability: {
      repetitions: number;
      excludedCaseIds: string[];
      result: 'passed' | 'failed';
      evidence: string;
    };
    coverage: {
      requiredCaught: number;
      incidents: HarnessReplaySuiteProbe[];
      escalation: 'cheap_replay_sufficient' | 'full_workflow_replay_required';
    };
  };
  cases: HarnessReplayCase[];
}

export interface HarnessReplayContext {
  repoDir: string;
  harnessId: string;
  label: 'baseline' | 'candidate';
}

export interface HarnessReplayCaseResult {
  caseId: string;
  surface: HarnessReplaySurface;
  harnessId: string;
  status: HarnessReplayStatus;
  passed: boolean;
  stable: boolean;
  expected?: unknown;
  actual?: unknown;
  error?: string;
}

export interface HarnessReplayReport {
  schemaVersion: typeof HARNESS_REPLAY_SCHEMA_VERSION;
  reportId: string;
  suiteVersion: string;
  generatedAt: string;
  mode: HarnessReplayMode;
  tolerance: number;
  verdict: 'pass' | 'fail';
  baselineHarnessId: string;
  candidateHarnessId: string;
  D: number;
  totals: {
    cases: number;
    excluded: number;
    malformed: number;
    errors: number;
  };
  perSurface: Record<HarnessReplaySurface, {
    cases: number;
    D: number;
    baselineFailures: number;
    candidateFailures: number;
  }>;
  exclusions: Array<{ caseId: string; reason: string }>;
  cases: Array<{
    caseId: string;
    surface: HarnessReplaySurface;
    baseline: Pick<HarnessReplayCaseResult, 'status' | 'passed' | 'actual' | 'error'>;
    candidate: Pick<HarnessReplayCaseResult, 'status' | 'passed' | 'actual' | 'error'>;
    regressed: boolean;
  }>;
  reportPath?: string;
}

export interface HarnessReplayAdapterDeps {
  routeBatch: typeof routeBatch;
  runReview: typeof runReview;
  evaluateTask: typeof evaluateTask;
  expandIssue: typeof expandIssue;
}

export const harnessReplayDefaultDeps: HarnessReplayAdapterDeps = {
  routeBatch,
  runReview,
  evaluateTask,
  expandIssue,
};

export interface RunHarnessReplayOptions {
  repoDir: string;
  suite: HarnessReplaySuite;
  baselineHarnessId: string;
  candidateHarnessId: string;
  mode?: HarnessReplayMode;
  tolerance?: number;
  reportPath?: string;
  deps?: Partial<HarnessReplayAdapterDeps>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function malformed(caseId: string, surface: HarnessReplaySurface, harnessId: string, stable: boolean, message: string): HarnessReplayCaseResult {
  return {
    caseId,
    surface,
    harnessId,
    status: 'malformed',
    passed: false,
    stable,
    error: message,
  };
}

function compareDecision(
  actual: { planner?: string; coder?: string; reviewer?: string } | undefined,
  expected: RoutingReplayCaseInput['expectedDecision'],
): boolean {
  return actual?.planner === expected.planner
    && actual?.coder === expected.coder
    && actual?.reviewer === expected.reviewer;
}

async function replayRoutingCase(
  testCase: Extract<HarnessReplayCase, { surface: 'routing' }>,
  context: HarnessReplayContext,
  deps: HarnessReplayAdapterDeps,
): Promise<HarnessReplayCaseResult> {
  const { input } = testCase;
  if (!isString(input.prompt) || !input.expectedDecision) {
    return malformed(testCase.id, testCase.surface, context.harnessId, testCase.stable, 'routing case requires prompt and expectedDecision');
  }

  const result = await deps.routeBatch(
    [{ issueId: input.issueId, prompt: input.prompt }],
    { repoDir: context.repoDir },
  );
  const decision = result[0]?.decision;
  const actual = decision
    ? { planner: decision.planner, coder: decision.coder, reviewer: decision.reviewer }
    : undefined;
  return {
    caseId: testCase.id,
    surface: testCase.surface,
    harnessId: context.harnessId,
    status: compareDecision(actual, input.expectedDecision) ? 'passed' : 'failed',
    passed: compareDecision(actual, input.expectedDecision),
    stable: testCase.stable,
    expected: input.expectedDecision,
    actual,
  };
}

async function replayReviewCase(
  testCase: Extract<HarnessReplayCase, { surface: 'review' }>,
  context: HarnessReplayContext,
  deps: HarnessReplayAdapterDeps,
): Promise<HarnessReplayCaseResult> {
  const { input } = testCase;
  if (!isString(input.diff) || !isString(input.expectedVerdict)) {
    return malformed(testCase.id, testCase.surface, context.harnessId, testCase.stable, 'review case requires diff and expectedVerdict');
  }

  const reviewContext: ReviewContext = {
    diff: input.diff,
    plan: input.plan ?? 'No plan provided.',
    taskPacket: input.taskPacket ?? 'No task packet provided.',
    designContext: null,
    metadata: {
      branch: input.branch ?? `harness-replay/${testCase.id}`,
      files: input.files ?? [],
      hasUiChanges: input.hasUiChanges ?? false,
    },
  };
  const result = await deps.runReview(reviewContext, context.repoDir, {
    skipClaudePreflight: true,
    reviewers: ['general'],
  });
  const actual = { verdict: result.verdict };
  return {
    caseId: testCase.id,
    surface: testCase.surface,
    harnessId: context.harnessId,
    status: result.verdict === input.expectedVerdict ? 'passed' : 'failed',
    passed: result.verdict === input.expectedVerdict,
    stable: testCase.stable,
    expected: { verdict: input.expectedVerdict },
    actual,
  };
}

async function replayEvalJudgingCase(
  testCase: Extract<HarnessReplayCase, { surface: 'eval_judging' }>,
  context: HarnessReplayContext,
  deps: HarnessReplayAdapterDeps,
): Promise<HarnessReplayCaseResult> {
  const { input } = testCase;
  if (!isString(input.taskPrompt) || typeof input.expectedSuccess !== 'boolean') {
    return malformed(testCase.id, testCase.surface, context.harnessId, testCase.stable, 'eval_judging case requires taskPrompt and expectedSuccess');
  }

  const record = await deps.evaluateTask({
    taskPrompt: input.taskPrompt,
    prReviewOutput: input.prReviewOutput ?? '',
    interventions: [],
    interventionRecords: [],
    interventionText: '',
    metadata: { harnessReplay: true, harnessId: context.harnessId },
  }, input.outcomes);
  const actual = { success: record.outcomes?.success ?? false, score: record.score };
  return {
    caseId: testCase.id,
    surface: testCase.surface,
    harnessId: context.harnessId,
    status: actual.success === input.expectedSuccess ? 'passed' : 'failed',
    passed: actual.success === input.expectedSuccess,
    stable: testCase.stable,
    expected: { success: input.expectedSuccess },
    actual,
  };
}

async function replayIssueExpansionCase(
  testCase: Extract<HarnessReplayCase, { surface: 'issue_expansion' }>,
  context: HarnessReplayContext,
  deps: HarnessReplayAdapterDeps,
): Promise<HarnessReplayCaseResult> {
  const { input } = testCase;
  if (!isString(input.promptTemplate) || !isString(input.issueContext)) {
    return malformed(testCase.id, testCase.surface, context.harnessId, testCase.stable, 'issue_expansion case requires promptTemplate and issueContext');
  }

  const result = await deps.expandIssue({
    promptTemplate: input.promptTemplate,
    issueContext: input.issueContext,
    codebaseContext: input.codebaseContext ?? '',
    repoDir: context.repoDir,
    issueId: testCase.id,
  });
  const digest = sha256(result.text);
  const includesOk = (input.expectedIncludes ?? []).every((needle) => result.text.includes(needle));
  const hashOk = input.expectedTextSha256 ? digest === input.expectedTextSha256 : true;
  return {
    caseId: testCase.id,
    surface: testCase.surface,
    harnessId: context.harnessId,
    status: includesOk && hashOk ? 'passed' : 'failed',
    passed: includesOk && hashOk,
    stable: testCase.stable,
    expected: {
      textSha256: input.expectedTextSha256,
      includes: input.expectedIncludes ?? [],
    },
    actual: {
      textSha256: digest,
      length: result.text.length,
    },
  };
}

export async function replayHarnessCase(
  testCase: HarnessReplayCase,
  context: HarnessReplayContext,
  deps: HarnessReplayAdapterDeps = harnessReplayDefaultDeps,
): Promise<HarnessReplayCaseResult> {
  if (testCase.stable === false) {
    return {
      caseId: testCase.id,
      surface: testCase.surface,
      harnessId: context.harnessId,
      status: 'excluded',
      passed: false,
      stable: false,
      error: 'unstable case excluded by stability probe',
    };
  }

  try {
    return await withReplayHarnessEnv(context, async () => {
      if (testCase.schemaVersion !== HARNESS_REPLAY_SCHEMA_VERSION) {
        return malformed(testCase.id, testCase.surface, context.harnessId, testCase.stable, 'unsupported replay case schemaVersion');
      }
      switch (testCase.surface) {
        case 'routing':
          return await replayRoutingCase(testCase, context, deps);
        case 'review':
          return await replayReviewCase(testCase, context, deps);
        case 'eval_judging':
          return await replayEvalJudgingCase(testCase, context, deps);
        case 'issue_expansion':
          return await replayIssueExpansionCase(testCase, context, deps);
      }
    });
  } catch (error) {
    return {
      caseId: testCase.id,
      surface: testCase.surface,
      harnessId: context.harnessId,
      status: 'error',
      passed: false,
      stable: testCase.stable,
      error: errorMessage(error),
    };
  }
}

async function withReplayHarnessEnv<T>(context: HarnessReplayContext, fn: () => Promise<T>): Promise<T> {
  const previousId = process.env.WAVEMILL_REPLAY_HARNESS_ID;
  const previousLabel = process.env.WAVEMILL_REPLAY_HARNESS_LABEL;
  process.env.WAVEMILL_REPLAY_HARNESS_ID = context.harnessId;
  process.env.WAVEMILL_REPLAY_HARNESS_LABEL = context.label;
  try {
    return await fn();
  } finally {
    if (previousId === undefined) {
      delete process.env.WAVEMILL_REPLAY_HARNESS_ID;
    } else {
      process.env.WAVEMILL_REPLAY_HARNESS_ID = previousId;
    }
    if (previousLabel === undefined) {
      delete process.env.WAVEMILL_REPLAY_HARNESS_LABEL;
    } else {
      process.env.WAVEMILL_REPLAY_HARNESS_LABEL = previousLabel;
    }
  }
}

function emptySurfaceCounts(): HarnessReplayReport['perSurface'] {
  return {
    routing: { cases: 0, D: 0, baselineFailures: 0, candidateFailures: 0 },
    review: { cases: 0, D: 0, baselineFailures: 0, candidateFailures: 0 },
    eval_judging: { cases: 0, D: 0, baselineFailures: 0, candidateFailures: 0 },
    issue_expansion: { cases: 0, D: 0, baselineFailures: 0, candidateFailures: 0 },
  };
}

export function validateHarnessReplaySuite(value: unknown): HarnessReplaySuite {
  if (!value || typeof value !== 'object') {
    throw new Error('harness replay suite must be a JSON object');
  }
  const suite = value as HarnessReplaySuite;
  if (suite.schemaVersion !== HARNESS_REPLAY_SCHEMA_VERSION) {
    throw new Error(`unsupported harness replay suite schemaVersion: ${String((value as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  if (!isString(suite.suiteVersion)) {
    throw new Error('harness replay suite requires suiteVersion');
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error('harness replay suite requires at least one case');
  }
  const caught = suite.probes?.coverage?.incidents?.filter((incident) => incident.caught).length ?? 0;
  const requiredCaught = suite.probes?.coverage?.requiredCaught ?? 2;
  if (caught < requiredCaught) {
    throw new Error(`coverage probe caught ${caught}/${requiredCaught} required incidents`);
  }
  return suite;
}

export function loadHarnessReplaySuite(path: string): HarnessReplaySuite {
  const raw = readFileSync(path, 'utf-8');
  return validateHarnessReplaySuite(JSON.parse(raw));
}

export async function runHarnessReplay(options: RunHarnessReplayOptions): Promise<HarnessReplayReport> {
  const suite = validateHarnessReplaySuite(options.suite);
  const deps = { ...harnessReplayDefaultDeps, ...(options.deps ?? {}) };
  const mode = options.mode ?? 'shadow';
  const tolerance = options.tolerance ?? 1;
  const repoDir = resolve(options.repoDir);
  const perSurface = emptySurfaceCounts();
  const exclusions: HarnessReplayReport['exclusions'] = [];
  const reportCases: HarnessReplayReport['cases'] = [];
  let D = 0;
  let malformedCount = 0;
  let errorCount = 0;

  if (mode === 'enforce' && (!options.baselineHarnessId || !options.candidateHarnessId)) {
    throw new Error('enforce mode requires baseline and candidate harness IDs');
  }

  for (const testCase of suite.cases) {
    if (testCase.stable === false) {
      exclusions.push({ caseId: testCase.id, reason: 'unstable' });
      continue;
    }

    const baseline = await replayHarnessCase(testCase, {
      repoDir,
      harnessId: options.baselineHarnessId,
      label: 'baseline',
    }, deps);
    const candidate = await replayHarnessCase(testCase, {
      repoDir,
      harnessId: options.candidateHarnessId,
      label: 'candidate',
    }, deps);
    const regressed = baseline.passed && !candidate.passed;
    const counts = perSurface[testCase.surface];
    counts.cases += 1;
    if (regressed) {
      D += 1;
      counts.D += 1;
    }
    if (!baseline.passed) counts.baselineFailures += 1;
    if (!candidate.passed) counts.candidateFailures += 1;
    if (baseline.status === 'malformed' || candidate.status === 'malformed') malformedCount += 1;
    if (baseline.status === 'error' || candidate.status === 'error') errorCount += 1;
    reportCases.push({
      caseId: testCase.id,
      surface: testCase.surface,
      baseline: {
        status: baseline.status,
        passed: baseline.passed,
        actual: baseline.actual,
        error: baseline.error,
      },
      candidate: {
        status: candidate.status,
        passed: candidate.passed,
        actual: candidate.actual,
        error: candidate.error,
      },
      regressed,
    });
  }

  const enforcementInvalid = mode === 'enforce' && (reportCases.length === 0 || malformedCount > 0 || errorCount > 0);
  const verdict = !enforcementInvalid && D <= tolerance ? 'pass' : 'fail';
  const report: HarnessReplayReport = {
    schemaVersion: HARNESS_REPLAY_SCHEMA_VERSION,
    reportId: randomUUID(),
    suiteVersion: suite.suiteVersion,
    generatedAt: new Date().toISOString(),
    mode,
    tolerance,
    verdict,
    baselineHarnessId: options.baselineHarnessId,
    candidateHarnessId: options.candidateHarnessId,
    D,
    totals: {
      cases: reportCases.length,
      excluded: exclusions.length,
      malformed: malformedCount,
      errors: errorCount,
    },
    perSurface,
    exclusions,
    cases: reportCases,
  };

  if (options.reportPath) {
    const reportPath = resolve(repoDir, options.reportPath);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    report.reportPath = reportPath;
  }

  return report;
}

export interface RunHarnessReplayFromSuiteOptions {
  repoDir: string;
  suitePath?: string;
  baselineHarnessId: string;
  candidateHarnessId: string;
  mode?: HarnessReplayMode;
  tolerance?: number;
  reportPath?: string;
  deps?: Partial<HarnessReplayAdapterDeps>;
}

export async function runHarnessReplayFromSuite(options: RunHarnessReplayFromSuiteOptions): Promise<HarnessReplayReport> {
  const suitePath = resolve(options.repoDir, options.suitePath ?? DEFAULT_HARNESS_REPLAY_SUITE_PATH);
  if (!existsSync(suitePath)) {
    if (options.mode === 'enforce') {
      throw new Error(`harness replay suite not found: ${suitePath}`);
    }
    const report: HarnessReplayReport = {
      schemaVersion: HARNESS_REPLAY_SCHEMA_VERSION,
      reportId: randomUUID(),
      suiteVersion: HARNESS_REPLAY_SUITE_VERSION,
      generatedAt: new Date().toISOString(),
      mode: options.mode ?? 'shadow',
      tolerance: options.tolerance ?? 1,
      verdict: 'fail',
      baselineHarnessId: options.baselineHarnessId,
      candidateHarnessId: options.candidateHarnessId,
      D: 0,
      totals: { cases: 0, excluded: 0, malformed: 0, errors: 1 },
      perSurface: emptySurfaceCounts(),
      exclusions: [],
      cases: [],
    };
    if (options.reportPath) {
      const reportPath = resolve(options.repoDir, options.reportPath);
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
      report.reportPath = reportPath;
    }
    return report;
  }

  const suite = loadHarnessReplaySuite(suitePath);
  return runHarnessReplay({ ...options, suite });
}

export async function runConfiguredHarnessRetentionReplay(repoDir: string): Promise<HarnessReplayReport | null> {
  const config = getHarnessRetentionConfig(repoDir);
  if (!config.enabled) {
    return null;
  }
  const reportName = `harness-retention-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const reportPath = join(config.reportDir, reportName);
  return runHarnessReplayFromSuite({
    repoDir,
    suitePath: config.suitePath,
    baselineHarnessId: config.baselineHarnessId,
    candidateHarnessId: config.candidateHarnessId,
    mode: config.mode,
    tolerance: config.tolerance,
    reportPath,
  });
}

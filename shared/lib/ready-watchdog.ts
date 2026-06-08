import { appendFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getReadyRemediationConfig,
  getReadyWatchdogConfig,
  type ReadyWatchdogConfig,
} from './config.ts';
import { errorMessage } from './error-utils.ts';
import { normalizeJobs, type MillJob, type WorkflowStateLike } from './job-tracker.ts';
import { updateBranchWithBase, type BranchBaseUpdateResult } from './promotion-controller.ts';
import { mutateJsonState } from './state-mutex.ts';
import { readStageResult, updateStageResult, type ReadyArtifacts, type StageResult } from './stage-result.ts';

const execFileAsync = promisify(execFile);
const MAX_AUTO_UPDATE_ATTEMPTS = 3;
const FAILING_CHECK_STABILITY_THRESHOLD = 2;

export type ReadyWatchdogClassificationKind =
  | 'fresh'
  | 'auto-update'
  | 'stuck'
  | 'waiting-on-ci'
  | 'waiting-on-eval-comparison'
  | 'needs-user';

export interface ReadyTaskSnapshot {
  issueId: string;
  slug: string;
  branch: string;
  worktree: string;
  prNumber: number;
  controllerPhase: string;
  controllerUpdatedAt: string | null;
  currentAgent: string;
  currentModel: string;
  challengePairId: string | null;
  readyStateDir: string;
  readyResult: StageResult | null;
  readyArtifacts: ReadyArtifacts | null;
  readyResultStatus: string | null;
  readyVerdict: ReadyArtifacts['verdict'] | null;
  readyAttentionDetail: string | null;
  hasNeedsAttention: boolean;
  hasConflictMarker: boolean;
  remediationLaunchHead: string | null;
  currentHead: string | null;
  relevantJobs: MillJob[];
  lastProgressAt: string | null;
  idleMinutes: number | null;
}

export interface NormalizedCheckSummary {
  name: string;
  status: 'success' | 'pending' | 'failure' | 'neutral' | 'skipped' | 'unknown';
  rawStatus: string;
}

export interface GitHubPRTruth {
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  checks: NormalizedCheckSummary[];
}

export interface ReadyWatchdogClassification {
  kind: ReadyWatchdogClassificationKind;
  detail: string;
  recoveryCommand?: string;
  autoRecoverable?: boolean;
  autoRemediable?: boolean;
}

export interface ReadyWatchdogAuditRecord {
  timestamp: string;
  taskId: string;
  slug: string;
  prNumber: number;
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  action: string;
  detail: string;
  recoveryCommand?: string;
  error?: string;
}

export interface ReadyWatchdogStateEntry {
  issueId: string;
  slug: string;
  prNumber: number;
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  displayLabel: string;
  detail: string;
  action: string;
  recoveryCommand?: string;
  updatedAt: string;
  idleMinutes: number | null;
  lastProgressAt: string | null;
  prStateKey?: string;
  detailFingerprint?: string;
  autoUpdateAttempts?: number;
  lastAutoUpdateError?: string;
  lastReportedAction?: string;
  failingChecksFingerprint?: string;
  failingChecksObservedCount?: number;
}

export interface ReadyWatchdogStateFile {
  updatedAt: string;
  tasks: Record<string, ReadyWatchdogStateEntry>;
}

export interface TickReadyWatchdogResult {
  updatedAt: string;
  findings: ReadyWatchdogStateEntry[];
}

export interface ReadyWatchdogDeps {
  readWorkflowState: (stateFile: string) => Promise<WorkflowStateLike>;
  fetchGitHubTruth: (prNumber: number, repoDir: string) => Promise<GitHubPRTruth>;
  getCurrentHead: (worktree: string) => Promise<string | null>;
  updateBehindBranch: (
    snapshot: ReadyTaskSnapshot,
    githubTruth: GitHubPRTruth,
    repoDir: string,
  ) => Promise<BranchBaseUpdateResult>;
  launchReadyRemediation: (
    snapshot: ReadyTaskSnapshot,
    failedCheckSummary: string,
    failedCheckNames: string[],
    attemptNumber: number,
    maxAttempts: number,
    repoDir: string,
  ) => Promise<ReadyRemediationLaunchResult>;
  now: () => Date;
}

export interface ReadyRemediationLaunchResult {
  status: 'launched' | 'skipped-in-flight' | 'skipped-max-attempts' | 'failed';
  detail: string;
  attemptNumber: number;
  launchHead?: string;
}

export interface TickReadyWatchdogOptions {
  repoDir: string;
  stateFile: string;
  config?: ReadyWatchdogConfig;
  issueFilter?: string;
  forceRecover?: boolean;
  deps?: Partial<ReadyWatchdogDeps>;
}

interface WorkflowTaskRecord extends Record<string, unknown> {
  slug?: string;
  branch?: string;
  worktree?: string;
  pr?: string | number;
  phase?: string;
  status?: string;
  updated?: string;
  agent?: string;
  model?: string;
  challengePairId?: string;
}

const defaultDeps: ReadyWatchdogDeps = {
  async readWorkflowState(stateFile) {
    return JSON.parse(await readFile(stateFile, 'utf-8')) as WorkflowStateLike;
  },
  async fetchGitHubTruth(prNumber, repoDir) {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'state,mergeable,mergeStateStatus,statusCheckRollup,url,headRefName,baseRefName',
      ],
      {
        cwd: repoDir,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      },
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      state: String(parsed.state ?? ''),
      mergeable: String(parsed.mergeable ?? ''),
      mergeStateStatus: String(parsed.mergeStateStatus ?? ''),
      url: typeof parsed.url === 'string' ? parsed.url : undefined,
      headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : undefined,
      baseRefName: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : undefined,
      checks: normalizeStatusCheckRollup(parsed.statusCheckRollup),
    };
  },
  async getCurrentHead(worktree) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },
  async updateBehindBranch(snapshot, githubTruth) {
    const branch = githubTruth.headRefName || snapshot.branch;
    const baseBranch = githubTruth.baseRefName;
    if (!baseBranch) {
      return {
        status: 'unknown-failed',
        detail: `cannot determine the base branch for PR #${snapshot.prNumber}`,
      };
    }

    return updateBranchWithBase(branch, baseBranch, snapshot.worktree);
  },
  async launchReadyRemediation(snapshot, failedCheckSummary, failedCheckNames, attemptNumber, maxAttempts, repoDir) {
    const toolPath = path.join(repoDir, 'tools', 'ready-watchdog.ts');
    try {
      const { stdout } = await execFileAsync(
        'npx',
        [
          'tsx',
          toolPath,
          '--repo-dir',
          repoDir,
          '--launch-remediation',
          snapshot.issueId,
          '--failed-check-summary',
          failedCheckSummary,
          '--failed-check-names-json',
          JSON.stringify(failedCheckNames),
          '--attempt-number',
          String(attemptNumber),
          '--max-attempts',
          String(maxAttempts),
        ],
        {
          cwd: repoDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        },
      );
      return JSON.parse(stdout) as ReadyRemediationLaunchResult;
    } catch (error) {
      return {
        status: 'failed',
        detail: `Ready watchdog could not launch remediation tool: ${errorMessage(error)}`,
        attemptNumber,
      };
    }
  },
  now: () => new Date(),
};

export function normalizeStatusCheckRollup(raw: unknown): NormalizedCheckSummary[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((item, index) => {
    const entry = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    const rawStatus = String(entry.conclusion ?? entry.state ?? '').toUpperCase();
    const name = String(entry.name ?? entry.context ?? `check-${index + 1}`);
    let status: NormalizedCheckSummary['status'] = 'unknown';

    if (rawStatus === 'SUCCESS') status = 'success';
    else if (rawStatus === 'NEUTRAL') status = 'neutral';
    else if (rawStatus === 'SKIPPED') status = 'skipped';
    else if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'ACTION_REQUIRED'].includes(rawStatus)) {
      status = 'pending';
    } else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(rawStatus)) {
      status = 'failure';
    }

    return { name, status, rawStatus };
  });
}

function summarizeChecks(checks: NormalizedCheckSummary[]): {
  failures: string[];
  pending: string[];
  successes: number;
} {
  const failures: string[] = [];
  const pending: string[] = [];
  let successes = 0;

  for (const check of checks) {
    if (check.status === 'failure') {
      failures.push(`${check.name} (${check.rawStatus || 'FAILURE'})`);
    } else if (check.status === 'pending') {
      pending.push(`${check.name} (${check.rawStatus || 'PENDING'})`);
    } else if (['success', 'neutral', 'skipped'].includes(check.status)) {
      successes += 1;
    }
  }

  return { failures, pending, successes };
}

function buildFailingChecksFingerprint(checks: NormalizedCheckSummary[]): string | undefined {
  const fingerprint = checks
    .filter((check) => check.status === 'failure')
    .map((check) => `${check.name.trim().toLowerCase()}:${(check.rawStatus || 'FAILURE').trim().toLowerCase()}`)
    .sort()
    .join(',');
  return fingerprint || undefined;
}

function displayLabel(kind: Exclude<ReadyWatchdogClassificationKind, 'fresh'>): string {
  if (kind === 'auto-update') return 'auto update';
  if (kind === 'waiting-on-ci') return 'waiting on CI';
  if (kind === 'waiting-on-eval-comparison') return 'waiting on eval/comparison';
  if (kind === 'needs-user') return 'needs user';
  return 'stuck';
}

function readyStateDir(worktree: string, slug: string): string {
  for (const dir of ['features', 'bugs']) {
    const candidate = path.join(worktree, dir, slug);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(worktree, 'features', slug);
}

function readAttentionDetail(stateDir: string): string | null {
  const file = path.join(stateDir, '.needs-attention');
  if (!existsSync(file)) {
    return null;
  }

  try {
    const content = readFileSync(file, 'utf-8');
    return content.split(/\r?\n/, 1)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fileMtimeIso(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function computeLastProgressAt(task: WorkflowTaskRecord, readyResult: StageResult | null, readyResultFile: string): string | null {
  const candidates = [
    task.updated,
    readyResult?.finishedAt ?? null,
    readyResult?.startedAt ?? null,
    fileMtimeIso(readyResultFile),
  ]
    .map(parseIsoDate)
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime());

  return candidates[0]?.toISOString() ?? null;
}

function computeIdleMinutes(lastProgressAt: string | null, now: Date): number | null {
  const parsed = parseIsoDate(lastProgressAt);
  if (!parsed) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 60_000));
}

function hasRunningEvalOrComparison(snapshot: ReadyTaskSnapshot): boolean {
  return snapshot.relevantJobs.some((job) => job.status === 'running');
}

function isCleanMergeState(githubTruth: GitHubPRTruth): boolean {
  return githubTruth.state === 'OPEN'
    && githubTruth.mergeable === 'MERGEABLE'
    && ['CLEAN', 'HAS_HOOKS'].includes(githubTruth.mergeStateStatus);
}

function isBehindMergeState(githubTruth: GitHubPRTruth): boolean {
  return githubTruth.state === 'OPEN'
    && githubTruth.mergeable === 'MERGEABLE'
    && githubTruth.mergeStateStatus === 'BEHIND';
}

function buildPrStateKey(githubTruth: GitHubPRTruth | null): string | undefined {
  if (!githubTruth) {
    return undefined;
  }

  return [githubTruth.state, githubTruth.mergeable, githubTruth.mergeStateStatus]
    .map((value) => String(value || '').trim().toUpperCase())
    .join('|');
}

function normalizeDetailFingerprint(detail: string): string {
  return detail.trim().replace(/\s+/g, ' ');
}

function makeRecoveryCommand(repoDir: string, stateFile: string, issueId: string): string {
  return `npx tsx ${path.join(repoDir, 'tools/ready-watchdog.ts')} --repo-dir ${repoDir} --state-file ${stateFile} --recover ${issueId} --json`;
}

export function classifyReadyTask(
  snapshot: ReadyTaskSnapshot,
  githubTruth: GitHubPRTruth | null,
  now: Date,
  config: Required<ReadyWatchdogConfig>,
): ReadyWatchdogClassification {
  if (snapshot.lastProgressAt === null || snapshot.idleMinutes === null) {
    return {
      kind: 'needs-user',
      detail: 'Ready watchdog could not determine the last local progress timestamp.',
    };
  }

  if (snapshot.idleMinutes < config.thresholdMinutes) {
    return {
      kind: 'fresh',
      detail: `Ready stage idle for ${snapshot.idleMinutes}m, below threshold.`,
    };
  }

  if (hasRunningEvalOrComparison(snapshot)) {
    const runningJobs = snapshot.relevantJobs
      .filter((job) => job.status === 'running')
      .map((job) => `${job.kind}:${job.id}`);
    return {
      kind: 'waiting-on-eval-comparison',
      detail: `Background jobs still running: ${runningJobs.join(', ')}.`,
    };
  }

  if (!githubTruth) {
    return {
      kind: 'needs-user',
      detail: 'Ready watchdog could not read GitHub PR state.',
    };
  }

  if (githubTruth.state !== 'OPEN') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is ${githubTruth.state.toLowerCase()}, so ready cannot advance automatically.`,
    };
  }

  if (githubTruth.mergeable === 'CONFLICTING' || githubTruth.mergeStateStatus === 'DIRTY') {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} has real merge conflicts on GitHub.`,
    };
  }

  if (githubTruth.mergeable === 'UNKNOWN' || githubTruth.mergeStateStatus === 'UNKNOWN') {
    return {
      kind: 'needs-user',
      detail: `GitHub mergeability for PR #${snapshot.prNumber} is still unknown.`,
    };
  }

  if (isBehindMergeState(githubTruth)) {
    return {
      kind: 'auto-update',
      detail: `PR #${snapshot.prNumber} is mergeable but behind ${githubTruth.baseRefName ?? 'its base branch'}.`,
    };
  }

  const checkSummary = summarizeChecks(githubTruth.checks);
  if (checkSummary.failures.length > 0) {
    return {
      kind: 'waiting-on-ci',
      detail: `Failing checks: ${checkSummary.failures.join(', ')}.`,
      autoRemediable: checkSummary.pending.length === 0,
    };
  }

  if (checkSummary.pending.length > 0) {
    return {
      kind: 'waiting-on-ci',
      detail: `Checks still pending: ${checkSummary.pending.join(', ')}.`,
    };
  }

  if (isCleanMergeState(githubTruth) && checkSummary.successes > 0) {
    const remediationInFlight = snapshot.hasConflictMarker
      && snapshot.readyResultStatus === 'running'
      && snapshot.remediationLaunchHead !== null
      && snapshot.currentHead !== null
      && snapshot.remediationLaunchHead === snapshot.currentHead;

    return {
      kind: 'stuck',
      detail: `Local ready state has been idle for ${snapshot.idleMinutes}m while PR #${snapshot.prNumber} is clean and green.`,
      autoRecoverable: !remediationInFlight,
    };
  }

  if (githubTruth.checks.length === 0) {
    return {
      kind: 'needs-user',
      detail: `PR #${snapshot.prNumber} is open but GitHub reported no status checks.`,
    };
  }

  return {
    kind: 'needs-user',
    detail: `PR #${snapshot.prNumber} is blocked by merge state ${githubTruth.mergeStateStatus || githubTruth.mergeable}.`,
  };
}

async function buildSnapshot(
  issueId: string,
  task: WorkflowTaskRecord,
  jobs: Record<string, MillJob>,
  now: Date,
  deps: ReadyWatchdogDeps,
): Promise<ReadyTaskSnapshot | null> {
  const slug = task.slug;
  const branch = task.branch;
  const worktree = task.worktree;
  const prNumber = Number(task.pr);

  if (!slug || !branch || !worktree || !Number.isFinite(prNumber) || prNumber <= 0) {
    return null;
  }

  const stateDir = readyStateDir(worktree, slug);
  const readyResultFile = path.join(stateDir, '.ready-result.json');
  const readyResult = await readStageResult(stateDir, 'ready');
  const readyArtifacts = readyResult?.artifacts?.type === 'ready'
    ? readyResult.artifacts
    : null;

  const relevantJobs = Object.values(jobs).filter((job) => {
    if (job.status !== 'running') {
      return false;
    }

    if (job.issueId === issueId) {
      return true;
    }

    if (task.challengePairId && job.pairId === task.challengePairId) {
      return true;
    }

    return Array.isArray(job.prNumbers) && job.prNumbers.includes(prNumber);
  });

  const lastProgressAt = computeLastProgressAt(task, readyResult, readyResultFile);

  return {
    issueId,
    slug,
    branch,
    worktree,
    prNumber,
    controllerPhase: String(task.phase ?? ''),
    controllerUpdatedAt: typeof task.updated === 'string' ? task.updated : null,
    currentAgent: String(task.agent ?? ''),
    currentModel: String(task.model ?? ''),
    challengePairId: typeof task.challengePairId === 'string' ? task.challengePairId : null,
    readyStateDir: stateDir,
    readyResult,
    readyArtifacts,
    readyResultStatus: readyResult?.status ?? null,
    readyVerdict: readyArtifacts?.verdict ?? null,
    readyAttentionDetail: readAttentionDetail(stateDir),
    hasNeedsAttention: existsSync(path.join(stateDir, '.needs-attention')),
    hasConflictMarker: existsSync(path.join(stateDir, '.conflict-detected')),
    remediationLaunchHead: readyArtifacts?.remediationLaunchHead ?? null,
    currentHead: await deps.getCurrentHead(worktree),
    relevantJobs,
    lastProgressAt,
    idleMinutes: computeIdleMinutes(lastProgressAt, now),
  };
}

async function recoverReadyState(
  snapshot: ReadyTaskSnapshot,
  githubTruth: GitHubPRTruth,
  stateFile: string,
  deps: ReadyWatchdogDeps,
  note = 'Ready watchdog cleared stale local state and queued a re-check.',
): Promise<void> {
  await rm(path.join(snapshot.readyStateDir, '.needs-attention'), { force: true });
  await rm(path.join(snapshot.readyStateDir, '.conflict-detected'), { force: true });
  await rm(path.join(snapshot.readyStateDir, '.conflict-attention-head'), { force: true });
  await rm(path.join(snapshot.readyStateDir, '.conflict-attention-reported'), { force: true });

  const priorArtifacts = snapshot.readyArtifacts ?? { type: 'ready' } as ReadyArtifacts;
  const nextArtifacts: ReadyArtifacts = {
    ...priorArtifacts,
    type: 'ready',
    prNumber: snapshot.prNumber,
    verdict: 'pending',
    mergeConflict: githubTruth.mergeStateStatus,
  };
  delete nextArtifacts.remediationLaunchHead;

  await updateStageResult(snapshot.readyStateDir, 'ready', {
    status: 'running',
    finishedAt: null,
    agent: snapshot.currentAgent,
    model: snapshot.currentModel,
    notes: note,
    artifacts: nextArtifacts,
  });

  await mutateJsonState<WorkflowStateLike>(stateFile, (current) => {
    const tasks = { ...(current.tasks ?? {}) };
    const existingTask = typeof tasks[snapshot.issueId] === 'object' && tasks[snapshot.issueId] !== null
      ? tasks[snapshot.issueId] as Record<string, unknown>
      : {};
    tasks[snapshot.issueId] = {
      ...existingTask,
      updated: deps.now().toISOString(),
    };
    return {
      ...current,
      tasks,
      updated: deps.now().toISOString(),
    };
  });
}

async function writeAuditRecord(repoDir: string, record: ReadyWatchdogAuditRecord): Promise<void> {
  const auditPath = path.join(repoDir, '.wavemill', 'ready-watchdog.jsonl');
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf-8');
}

async function loadPriorWatchdogState(repoDir: string): Promise<ReadyWatchdogStateFile | null> {
  const statePath = path.join(repoDir, '.wavemill', 'ready-watchdog-state.json');
  try {
    const content = await readFile(statePath, 'utf-8');
    return JSON.parse(content) as ReadyWatchdogStateFile;
  } catch {
    return null;
  }
}

async function writeStateFile(repoDir: string, findings: ReadyWatchdogStateEntry[], now: Date): Promise<void> {
  const statePath = path.join(repoDir, '.wavemill', 'ready-watchdog-state.json');
  await mutateJsonState<ReadyWatchdogStateFile>(
    statePath,
    () => ({
      updatedAt: now.toISOString(),
      tasks: Object.fromEntries(findings.map((entry) => [entry.issueId, entry])),
    }),
    {
      createIfMissing: true,
      initial: {
        updatedAt: now.toISOString(),
        tasks: {},
      },
    },
  );
}

function materiallyChanged(
  prior: ReadyWatchdogStateEntry | undefined,
  next: ReadyWatchdogStateEntry,
): boolean {
  if (!prior) {
    return true;
  }

  return prior.classification !== next.classification
    || prior.detailFingerprint !== next.detailFingerprint
    || prior.prStateKey !== next.prStateKey
    || prior.autoUpdateAttempts !== next.autoUpdateAttempts
    || prior.lastAutoUpdateError !== next.lastAutoUpdateError
    || prior.lastReportedAction !== next.lastReportedAction
    || prior.recoveryCommand !== next.recoveryCommand
    || prior.failingChecksFingerprint !== next.failingChecksFingerprint
    || prior.failingChecksObservedCount !== next.failingChecksObservedCount;
}

function buildFindingEntry(input: {
  issueId: string;
  snapshot: ReadyTaskSnapshot;
  classification: Exclude<ReadyWatchdogClassificationKind, 'fresh'>;
  detail: string;
  action: string;
  now: Date;
  recoveryCommand?: string;
  githubTruth?: GitHubPRTruth | null;
  autoUpdateAttempts?: number;
  lastAutoUpdateError?: string;
  failingChecksFingerprint?: string;
  failingChecksObservedCount?: number;
}): ReadyWatchdogStateEntry {
  return {
    issueId: input.issueId,
    slug: input.snapshot.slug,
    prNumber: input.snapshot.prNumber,
    classification: input.classification,
    displayLabel: displayLabel(input.classification),
    detail: input.detail,
    action: input.action,
    recoveryCommand: input.recoveryCommand,
    updatedAt: input.now.toISOString(),
    idleMinutes: input.snapshot.idleMinutes,
    lastProgressAt: input.snapshot.lastProgressAt,
    prStateKey: buildPrStateKey(input.githubTruth ?? null),
    detailFingerprint: normalizeDetailFingerprint(input.detail),
    autoUpdateAttempts: input.autoUpdateAttempts,
    lastAutoUpdateError: input.lastAutoUpdateError,
    lastReportedAction: input.action,
    failingChecksFingerprint: input.failingChecksFingerprint,
    failingChecksObservedCount: input.failingChecksObservedCount,
  };
}

function buildExhaustedAutoUpdateEntry(
  issueId: string,
  snapshot: ReadyTaskSnapshot,
  githubTruth: GitHubPRTruth,
  attempts: number,
  lastError: string,
  now: Date,
): ReadyWatchdogStateEntry {
  return buildFindingEntry({
    issueId,
    snapshot,
    classification: 'needs-user',
    detail: `Auto-update exhausted after ${attempts} attempts: ${lastError}`,
    action: 'needs-user',
    now,
    githubTruth,
    autoUpdateAttempts: attempts,
    lastAutoUpdateError: lastError,
  });
}

export async function tickReadyWatchdog(options: TickReadyWatchdogOptions): Promise<TickReadyWatchdogResult> {
  const deps: ReadyWatchdogDeps = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };
  const now = deps.now();
  const config = {
    ...getReadyWatchdogConfig(options.repoDir),
    ...(options.config ?? {}),
  };
  const newFindings: ReadyWatchdogStateEntry[] = [];

  if (!config.enabled && !options.forceRecover) {
    await writeStateFile(options.repoDir, [], now);
    return { updatedAt: now.toISOString(), findings: newFindings };
  }

  const priorState = await loadPriorWatchdogState(options.repoDir);
  const priorTasks = priorState?.tasks ?? {};
  const nextTasks = { ...priorTasks };
  const remediationConfig = getReadyRemediationConfig(options.repoDir);
  const workflowState = await deps.readWorkflowState(options.stateFile);
  const tasks = workflowState.tasks ?? {};
  const jobs = normalizeJobs(workflowState);
  const activeReadyIssueIds = new Set<string>();

  for (const [issueId, rawTask] of Object.entries(tasks)) {
    const task = rawTask as WorkflowTaskRecord;
    if (task.phase !== 'ready') {
      if (!options.issueFilter) {
        delete nextTasks[issueId];
      }
      continue;
    }
    if (task.status === 'merged' || task.status === 'completed-external') {
      if (!options.issueFilter) {
        delete nextTasks[issueId];
      }
      continue;
    }
    if (options.issueFilter && issueId !== options.issueFilter) {
      continue;
    }

    activeReadyIssueIds.add(issueId);

    const snapshot = await buildSnapshot(issueId, task, jobs, now, deps);
    if (!snapshot) {
      delete nextTasks[issueId];
      continue;
    }

    let githubTruth: GitHubPRTruth | null = null;
    let classification: ReadyWatchdogClassification;
    let fetchError: string | undefined;
    try {
      githubTruth = await deps.fetchGitHubTruth(snapshot.prNumber, options.repoDir);
      classification = classifyReadyTask(snapshot, githubTruth, now, config);
    } catch (error) {
      fetchError = errorMessage(error);
      classification = {
        kind: 'needs-user',
        detail: `Ready watchdog failed to query GitHub for PR #${snapshot.prNumber}: ${fetchError}`,
      };
    }

    const prior = priorTasks[issueId];
    const failingChecksFingerprint = buildFailingChecksFingerprint(githubTruth?.checks ?? []);
    const failingChecksObservedCount = failingChecksFingerprint
      ? prior?.failingChecksFingerprint === failingChecksFingerprint
        ? (prior.failingChecksObservedCount ?? 0) + 1
        : 1
      : 0;
    if (classification.kind === 'fresh') {
      continue;
    }

    let entry: ReadyWatchdogStateEntry | null = null;

    if (classification.kind === 'auto-update' && githubTruth) {
      const attempts = prior?.autoUpdateAttempts ?? 0;
      const lastError = prior?.lastAutoUpdateError;

      if (attempts >= MAX_AUTO_UPDATE_ATTEMPTS && lastError) {
        entry = buildExhaustedAutoUpdateEntry(
          issueId,
          snapshot,
          githubTruth,
          attempts,
          lastError,
          now,
        );
      } else {
        const updateResult = await deps.updateBehindBranch(snapshot, githubTruth, options.repoDir);
        if (updateResult.status === 'success') {
          await recoverReadyState(
            snapshot,
            githubTruth,
            options.stateFile,
            deps,
            'Ready watchdog updated the PR branch with the latest base and queued a re-check.',
          );
          delete nextTasks[issueId];
          continue;
        }

        const nextAttempts = attempts + 1;
        if (updateResult.status === 'conflict' || updateResult.status === 'dirty-worktree') {
          entry = buildFindingEntry({
            issueId,
            snapshot,
            classification: 'needs-user',
            detail: `Auto-update could not proceed for PR #${snapshot.prNumber}: ${updateResult.detail}`,
            action: 'needs-user',
            now,
            githubTruth,
            autoUpdateAttempts: nextAttempts,
            lastAutoUpdateError: updateResult.detail,
          });
        } else if (nextAttempts >= MAX_AUTO_UPDATE_ATTEMPTS) {
          entry = buildExhaustedAutoUpdateEntry(
            issueId,
            snapshot,
            githubTruth,
            nextAttempts,
            updateResult.detail,
            now,
          );
        } else {
          entry = buildFindingEntry({
            issueId,
            snapshot,
            classification: 'auto-update',
            detail: `Auto-update attempt ${nextAttempts}/${MAX_AUTO_UPDATE_ATTEMPTS} failed for PR #${snapshot.prNumber}: ${updateResult.detail}`,
            action: 'auto-update-failed',
            now,
            githubTruth,
            autoUpdateAttempts: nextAttempts,
            lastAutoUpdateError: updateResult.detail,
          });
        }
      }
    } else {
      let action = 'reported';
      let recoveryCommand = classification.recoveryCommand;
      if (
        classification.kind === 'waiting-on-ci'
        && classification.autoRemediable
        && githubTruth
        && remediationConfig.enabled
      ) {
        const attempts = snapshot.readyArtifacts?.remediationAttempts ?? 0;
        if (failingChecksObservedCount < FAILING_CHECK_STABILITY_THRESHOLD) {
          action = 'waiting-on-ci-stabilizing';
          classification = {
            ...classification,
            detail: `Failing checks remain unstable (${failingChecksObservedCount}/${FAILING_CHECK_STABILITY_THRESHOLD}): ${classification.detail}`,
          };
        } else if (attempts >= remediationConfig.maxAttempts) {
          action = 'remediation-exhausted';
          classification = {
            ...classification,
            detail: `Ready remediation capped at ${attempts}/${remediationConfig.maxAttempts} attempts for PR #${snapshot.prNumber}.`,
          };
        } else if (
          snapshot.remediationLaunchHead
          && snapshot.currentHead
          && snapshot.remediationLaunchHead === snapshot.currentHead
        ) {
          action = 'remediation-in-flight';
          classification = {
            ...classification,
            detail: `Ready remediation is already running for PR #${snapshot.prNumber} at ${snapshot.currentHead}.`,
          };
        } else {
          const checkSummary = summarizeChecks(githubTruth.checks);
          const failedCheckNames = githubTruth.checks
            .filter((check) => check.status === 'failure')
            .map((check) => check.name);
          const launchResult = await deps.launchReadyRemediation(
            snapshot,
            checkSummary.failures.join(', '),
            failedCheckNames,
            attempts + 1,
            remediationConfig.maxAttempts,
            options.repoDir,
          );

          if (launchResult.status === 'launched') {
            action = 'launched-remediation';
          } else if (launchResult.status === 'skipped-in-flight') {
            action = 'remediation-in-flight';
          } else if (launchResult.status === 'skipped-max-attempts') {
            action = 'remediation-exhausted';
          } else {
            action = 'remediation-launch-failed';
          }

          classification = {
            ...classification,
            detail: launchResult.detail,
          };
        }
      } else if (classification.kind === 'stuck') {
        recoveryCommand = makeRecoveryCommand(options.repoDir, options.stateFile, issueId);
        const canRecover = (options.forceRecover || config.autoRecover)
          && classification.autoRecoverable
          && githubTruth !== null;

        if (canRecover && githubTruth) {
          await recoverReadyState(snapshot, githubTruth, options.stateFile, deps);
          action = options.forceRecover ? 'manual-recovery' : 'auto-recovered';
        } else {
          action = 'recovery-command';
        }
      }

      entry = buildFindingEntry({
        issueId,
        snapshot,
        classification: classification.kind,
        detail: classification.detail,
        action,
        now,
        recoveryCommand,
        githubTruth,
        failingChecksFingerprint,
        failingChecksObservedCount,
      });
    }

    if (!entry) {
      continue;
    }

    nextTasks[issueId] = entry;
    if (materiallyChanged(prior, entry)) {
      newFindings.push(entry);
      await writeAuditRecord(options.repoDir, {
        timestamp: now.toISOString(),
        taskId: issueId,
        slug: snapshot.slug,
        prNumber: snapshot.prNumber,
        classification: entry.classification,
        action: entry.action,
        detail: entry.detail,
        recoveryCommand: entry.recoveryCommand,
        error: fetchError,
      });
    }
  }

  if (!options.issueFilter) {
    for (const issueId of Object.keys(nextTasks)) {
      if (!activeReadyIssueIds.has(issueId)) {
        delete nextTasks[issueId];
      }
    }
  }

  await writeStateFile(options.repoDir, Object.values(nextTasks), now);
  return {
    updatedAt: now.toISOString(),
    findings: newFindings,
  };
}

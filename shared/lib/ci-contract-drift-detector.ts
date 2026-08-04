import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { discoverGitHubRequiredChecks } from './github-ci-discovery.ts';
import {
  GitHubAPIError,
  GitHubPermissionError,
} from './github-ci-discovery.ts';
import type { GitHubDiscoveryResult } from './github-ci-discovery.ts';
import type { PrePrVerificationConfigSchema } from './config.ts';
import type { PrePrVerificationCheckConfig } from './pre-pr-verification-types.ts';

export type DriftState =
  | 'ALIGNED'
  | 'RECIPE_MISSING'
  | 'CHECK_MISSING'
  | 'CHECK_UNMAPPED'
  | 'WORKFLOW_CHANGED'
  | 'METADATA_UNAVAILABLE'
  | 'REQUIRES_REVIEW';

export type DriftAction =
  | 'ADD_TO_RECIPE'
  | 'ADD_RATIONALE'
  | 'UPDATE_WORKFLOW_MAPPING'
  | 'REVIEW_MAPPING'
  | 'CONFIGURE_RECIPE'
  | 'RETRY_METADATA';

export interface DriftFinding {
  checkName: string;
  state: DriftState;
  sourceType?: 'workflow' | 'integration' | 'required-status-check';
  workflowFile?: string;
  workflowJob?: string;
  recipeEntry?: PrePrVerificationCheckConfig;
  action?: DriftAction;
  details?: string;
}

export interface DriftReport {
  repository: string;
  branch: string;
  timestamp: string;
  status: 'ALIGNED' | 'REQUIRES_REVIEW' | 'METADATA_UNAVAILABLE';
  summary: string;
  findings: DriftFinding[];
  checksTotal: number;
  checksAligned: number;
  checksUnmapped: number;
  checksRemoteOnly: number;
}

export interface DetectContractDriftOptions {
  repoDir: string;
  repo: string;
  branch: string;
  recipe?: PrePrVerificationConfigSchema;
  githubChecks?: string[];
  workflows?: GitHubDiscoveryResult['workflows'];
  timeout?: number;
  cacheTtlMs?: number;
  useCache?: boolean;
  discoverChecks?: (repo: string, branch: string) => Promise<GitHubDiscoveryResult>;
}

interface GitHubCheckCache {
  repository: string;
  branch: string;
  checks: string[];
  timestamp: number;
  source: 'protection' | 'ruleset' | 'mixed';
  workflows?: GitHubDiscoveryResult['workflows'];
}

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

export async function detectContractDrift(
  options: DetectContractDriftOptions
): Promise<DriftReport> {
  const timestamp = new Date().toISOString();
  const recipe = options.recipe;
  if (!recipe?.enabled || !recipe.recipe?.commands?.length) {
    return buildReport({
      repository: options.repo,
      branch: options.branch,
      timestamp,
      findings: [
        {
          checkName: '(prePrVerification)',
          state: 'RECIPE_MISSING',
          action: 'CONFIGURE_RECIPE',
          details: 'prePrVerification.enabled and recipe.commands are required before drift can be evaluated.',
        },
      ],
    });
  }

  let metadata = {
    checks: options.githubChecks,
    workflows: options.workflows,
  };
  if (!metadata.checks) {
    try {
      metadata = await discoverChecksWithCache(options);
    } catch (err) {
      return metadataUnavailableReport(options, timestamp, err);
    }
  }

  const checks = metadata.checks ?? [];
  const workflowJobs = metadata.workflows ?? [];
  const findings: DriftFinding[] = [];
  const mappedChecks = recipe.checks ?? {};

  if (checks.length === 0) {
    return buildReport({
      repository: options.repo,
      branch: options.branch,
      timestamp,
      findings: [
        {
          checkName: '(github metadata)',
          state: 'METADATA_UNAVAILABLE',
          action: 'RETRY_METADATA',
          details: 'No enforced GitHub checks were available for comparison.',
        },
      ],
    });
  }

  for (const checkName of checks) {
    findings.push(classifyCheck({
      checkName,
      entry: mappedChecks[checkName],
      repoDir: options.repoDir,
      workflowJobs,
    }));
  }

  for (const [checkName, entry] of Object.entries(mappedChecks)) {
    if (entry.type !== 'workflow' || checks.includes(checkName)) {
      continue;
    }
    const workflowFinding = classifyWorkflowMapping(checkName, entry, options.repoDir, workflowJobs);
    if (workflowFinding.state !== 'ALIGNED') {
      findings.push(workflowFinding);
    }
  }

  return buildReport({
    repository: options.repo,
    branch: options.branch,
    timestamp,
    findings,
  });
}

function classifyCheck(opts: {
  checkName: string;
  entry?: PrePrVerificationCheckConfig;
  repoDir: string;
  workflowJobs: NonNullable<GitHubDiscoveryResult['workflows']>;
}): DriftFinding {
  const { checkName, entry, repoDir, workflowJobs } = opts;
  if (!entry) {
    const inferred = inferWorkflowFromCheck(checkName, workflowJobs);
    return {
      checkName,
      state: 'CHECK_MISSING',
      sourceType: inferred ? 'workflow' : 'required-status-check',
      workflowFile: inferred?.path,
      workflowJob: inferred?.name,
      action: inferred ? 'ADD_TO_RECIPE' : 'REVIEW_MAPPING',
      details: inferred
        ? `Add a mapping for workflow job "${inferred.name}" in ${inferred.path}.`
        : 'Enforced check has no local mapping. Add a workflow, integration, or remote-only entry.',
    };
  }

  if (entry.type === 'workflow') {
    return classifyWorkflowMapping(checkName, entry, repoDir, workflowJobs);
  }

  if (entry.type === 'remote-only') {
    if (hasAcknowledgedRationale(entry)) {
      return {
        checkName,
        state: 'ALIGNED',
        sourceType: 'required-status-check',
        recipeEntry: entry,
        details: 'Remote-only check is explicitly acknowledged and remains required in GitHub CI.',
      };
    }
    return {
      checkName,
      state: 'CHECK_UNMAPPED',
      sourceType: 'required-status-check',
      recipeEntry: entry,
      action: 'ADD_RATIONALE',
      details: 'Remote-only checks require rationale, maintainer acknowledgement, and acknowledgement date.',
    };
  }

  if (entry.type === 'integration') {
    return {
      checkName,
      state: 'ALIGNED',
      sourceType: 'integration',
      recipeEntry: entry,
      details: 'Integration check is mapped for manual review of third-party provenance.',
    };
  }

  return {
    checkName,
    state: 'REQUIRES_REVIEW',
    recipeEntry: entry,
    action: 'REVIEW_MAPPING',
    details: 'Unknown check mapping type.',
  };
}

function classifyWorkflowMapping(
  checkName: string,
  entry: Extract<PrePrVerificationCheckConfig, { type: 'workflow' }>,
  repoDir: string,
  workflowJobs: NonNullable<GitHubDiscoveryResult['workflows']>
): DriftFinding {
  const workflowPath = resolve(repoDir, entry.workflowFile);
  if (!existsSync(workflowPath)) {
    return {
      checkName,
      state: 'WORKFLOW_CHANGED',
      sourceType: 'workflow',
      workflowFile: entry.workflowFile,
      workflowJob: entry.workflowJob,
      recipeEntry: entry,
      action: 'UPDATE_WORKFLOW_MAPPING',
      details: `Configured workflow file is missing: ${entry.workflowFile}`,
    };
  }

  if (!workflowContainsJob(workflowPath, entry.workflowJob)) {
    return {
      checkName,
      state: 'WORKFLOW_CHANGED',
      sourceType: 'workflow',
      workflowFile: entry.workflowFile,
      workflowJob: entry.workflowJob,
      recipeEntry: entry,
      action: 'UPDATE_WORKFLOW_MAPPING',
      details: `Configured workflow job is missing or renamed: ${entry.workflowJob}`,
    };
  }

  const githubJob = workflowJobs.find(
    (job) => job.path === entry.workflowFile && job.name === entry.workflowJob
  );
  if (workflowJobs.length > 0 && !githubJob) {
    return {
      checkName,
      state: 'REQUIRES_REVIEW',
      sourceType: 'workflow',
      workflowFile: entry.workflowFile,
      workflowJob: entry.workflowJob,
      recipeEntry: entry,
      action: 'REVIEW_MAPPING',
      details: 'Local workflow mapping exists, but GitHub workflow provenance does not confirm it.',
    };
  }

  return {
    checkName,
    state: 'ALIGNED',
    sourceType: 'workflow',
    workflowFile: entry.workflowFile,
    workflowJob: entry.workflowJob,
    recipeEntry: entry,
    details: 'Workflow check mapping is present locally.',
  };
}

function workflowContainsJob(workflowPath: string, jobName: string): boolean {
  const workflow = readFileSync(workflowPath, 'utf-8');
  const jobs = extractWorkflowJobNames(workflow);
  return jobs.includes(jobName);
}

export function extractWorkflowJobNames(workflow: string): string[] {
  const jobs = new Set<string>();
  const lines = workflow.split(/\r?\n/);
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*(?:#.*)?$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(line)) {
      break;
    }
    if (!inJobs) {
      continue;
    }
    const match = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/);
    if (match) {
      jobs.add(match[1]);
    }
  }
  return [...jobs];
}

function hasAcknowledgedRationale(
  entry: Extract<PrePrVerificationCheckConfig, { type: 'remote-only' }>
): boolean {
  return Boolean(
    entry.rationale &&
    entry.rationale.trim().length >= 10 &&
    entry.acknowledgedBy &&
    entry.acknowledgedDate
  );
}

function inferWorkflowFromCheck(
  checkName: string,
  workflowJobs: NonNullable<GitHubDiscoveryResult['workflows']>
): { name: string; path: string } | null {
  const exact = workflowJobs.find((job) => job.name === checkName);
  if (exact) {
    return { name: exact.name, path: exact.path };
  }

  const suffix = workflowJobs.find((job) => checkName.endsWith(` / ${job.name}`));
  if (suffix) {
    return { name: suffix.name, path: suffix.path };
  }

  return null;
}

async function discoverChecksWithCache(
  options: DetectContractDriftOptions
): Promise<{ checks: string[]; workflows?: GitHubDiscoveryResult['workflows'] }> {
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (options.useCache !== false) {
    const cache = readCheckCache(options.repoDir, options.repo, options.branch, ttlMs);
    if (cache) {
      return { checks: cache.checks, workflows: cache.workflows };
    }
  }

  const discover = options.discoverChecks ?? discoverGitHubRequiredChecks;
  const result = await withTimeout(
    discover(options.repo, options.branch),
    (options.timeout ?? 30) * 1000
  );
  writeCheckCache(options.repoDir, {
    repository: options.repo,
    branch: options.branch,
    checks: result.checks,
    source: result.source,
    timestamp: Date.now(),
    workflows: result.workflows,
  });
  return { checks: result.checks, workflows: result.workflows };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolvePromise(value);
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function cachePath(repoDir: string): string {
  return join(repoDir, '.wavemill', 'github-checks-cache.json');
}

function readCheckCache(
  repoDir: string,
  repository: string,
  branch: string,
  ttlMs: number
): GitHubCheckCache | null {
  const path = cachePath(repoDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const cache = JSON.parse(readFileSync(path, 'utf-8')) as GitHubCheckCache;
    const fresh = Date.now() - cache.timestamp <= ttlMs;
    if (cache.repository !== repository || cache.branch !== branch || !fresh) {
      return null;
    }
    if (!Array.isArray(cache.checks)) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function writeCheckCache(repoDir: string, cache: GitHubCheckCache): void {
  const path = cachePath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
}

function metadataUnavailableReport(
  options: DetectContractDriftOptions,
  timestamp: string,
  err: unknown
): DriftReport {
  const error = err as Error;
  const details = error instanceof GitHubPermissionError
    ? error.message
    : error instanceof GitHubAPIError
      ? error.message
      : `GitHub metadata unavailable: ${error.message}`;
  return buildReport({
    repository: options.repo,
    branch: options.branch,
    timestamp,
    findings: [
      {
        checkName: '(github metadata)',
        state: 'METADATA_UNAVAILABLE',
        action: 'RETRY_METADATA',
        details,
      },
    ],
  });
}

function buildReport(opts: {
  repository: string;
  branch: string;
  timestamp: string;
  findings: DriftFinding[];
}): DriftReport {
  const checksAligned = opts.findings.filter((finding) => finding.state === 'ALIGNED').length;
  const checksRemoteOnly = opts.findings.filter(
    (finding) => finding.recipeEntry?.type === 'remote-only' && finding.state === 'ALIGNED'
  ).length;
  const checksUnmapped = opts.findings.filter((finding) => finding.state !== 'ALIGNED').length;
  const status = opts.findings.some((finding) => finding.state === 'METADATA_UNAVAILABLE')
    ? 'METADATA_UNAVAILABLE'
    : checksUnmapped > 0
      ? 'REQUIRES_REVIEW'
      : 'ALIGNED';

  return {
    repository: opts.repository,
    branch: opts.branch,
    timestamp: opts.timestamp,
    status,
    summary: summarizeFindings(opts.findings),
    findings: opts.findings,
    checksTotal: opts.findings.length,
    checksAligned,
    checksUnmapped,
    checksRemoteOnly,
  };
}

function summarizeFindings(findings: DriftFinding[]): string {
  if (findings.length === 0 || findings.every((finding) => finding.state === 'ALIGNED')) {
    return `${findings.length} check(s) aligned`;
  }

  const counts = new Map<DriftState, number>();
  for (const finding of findings) {
    if (finding.state === 'ALIGNED') {
      continue;
    }
    counts.set(finding.state, (counts.get(finding.state) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => `${count} ${state.toLowerCase().replaceAll('_', ' ')}`)
    .join(', ');
}

export function formatDriftReport(report: DriftReport): string {
  const lines = [
    '',
    'CI contract drift:',
    `  Repository: ${report.repository}`,
    `  Branch: ${report.branch}`,
    `  Status: ${report.status}`,
    `  Summary: ${report.summary}`,
  ];

  if (report.findings.length > 0) {
    lines.push('', '  Check | State | Action', '  --- | --- | ---');
    for (const finding of report.findings) {
      const action = finding.action ?? (finding.state === 'ALIGNED' ? 'OK' : 'REVIEW_MAPPING');
      lines.push(`  ${finding.checkName} | ${finding.state} | ${action}`);
      if (finding.details) {
        lines.push(`    ${finding.details}`);
      }
    }
  }

  return lines.join('\n');
}
